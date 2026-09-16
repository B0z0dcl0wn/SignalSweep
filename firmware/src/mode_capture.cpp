// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
//
// Stationary diagnostic packet capture.
//
// You stand next to a suspect device, the app sends CMD:CAP:START:<secs>, and
// this logs EVERY WiFi frame (all types) and EVERY BLE advertisement the board
// hears as a base64 "CAP:" line stream over USB, for the phone to save and the
// PC to analyze. It exists because the detector only reports what it already
// decided is interesting -- to find an unknown signature (e.g. a Flock camera on
// a randomized MAC carrying only the Lite-On IE) you need the raw air, not the
// detector's verdict.
//
// It PAUSES the detector for the duration. esp_wifi_set_promiscuous_rx_cb takes a
// single callback, so capture and detection cannot both own the radio; and this
// is run standing still next to a known device, not driving, so the beeper being
// off costs nothing. The detector is restored when the capture ends.
//
// The callbacks obey the same rule as the detector's: no malloc, no lock, no
// Serial -- they only copy bytes into a lock-free single-producer/single-consumer
// ring in PSRAM (8 MB, otherwise unused). A drain task base64-encodes records to
// USB. If the ring fills (USB slower than the air in a dense area) the producer
// increments a drop counter instead of blocking, and every drop is reported, so
// "lose no packets" is honest: nothing is lost silently, and you see the exact
// count if the budget was exceeded.
//
// Record layout (little-endian; ESP32 is LE), base64 of:
//   [0]     radio     0 = WiFi, 1 = BLE
//   [1..4]  seq       per-radio monotonic counter (a gap the drop count explains)
//   [5..8]  ts_us     micros() at capture
//   [9]     channel   WiFi channel (0 for BLE)
//   [10]    rssi      int8 dBm
//   [11..12] orig_len bytes the radio actually saw
//   [13..14] cap_len  bytes included below (<= CAP_MAX_BYTES)
//   [15..]  payload   cap_len bytes. WiFi: the 802.11 frame (from the MAC header,
//                     truncated -- a data frame's encrypted body is useless for
//                     fingerprinting and would blow the USB budget). BLE: 6-byte
//                     MAC (big-endian) + 1 addr-type byte + the advertisement.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <NimBLEDevice.h>
#include "mbedtls/base64.h"
#include "mode_capture.h"
#include "mode_watchers_watch.h"
#include "c5_radio.h"

static const char* TAG = "Capture";

#define CAP_MAX_BYTES   256
#define CAP_HDR_BYTES   15
#define WIFI_SLOTS      8192   // ~2.2 MB PSRAM: absorbs bursts of dense air
#define BLE_SLOTS       2048   // ~0.55 MB PSRAM

struct CapSlot {
    uint8_t  radio;
    uint32_t seq;
    uint32_t ts;
    uint8_t  ch;
    int8_t   rssi;
    uint16_t origLen;
    uint16_t capLen;
    uint8_t  data[CAP_MAX_BYTES];
};

// Single-producer / single-consumer ring. head is producer-owned, tail
// consumer-owned; both volatile so the two tasks see each other's progress.
struct CapRing {
    CapSlot*          slots;
    uint32_t          n;
    volatile uint32_t head;
    volatile uint32_t tail;
    volatile uint32_t drops;
    volatile uint32_t seq;
};

static CapRing wifiRing = {};
static CapRing bleRing  = {};

static volatile bool capturing          = false;
static volatile bool stopRequested      = false;
static volatile bool needDetectorRestart = false;
static uint32_t      capEndMs           = 0;
static TaskHandle_t  drainTaskHandle    = NULL;
static TaskHandle_t  hopTaskHandle      = NULL;

static bool ringAlloc(CapRing* r, uint32_t n) {
    r->slots = (CapSlot*)ps_malloc((size_t)n * sizeof(CapSlot));
    if (!r->slots) return false;
    r->n = n;
    r->head = r->tail = r->drops = r->seq = 0;
    return true;
}

static void ringFree(CapRing* r) {
    if (r->slots) free(r->slots);
    r->slots = NULL;
    r->n = 0;
}

// Producer side. Callback context: copies only, never blocks. Single producer
// per ring (WiFi promiscuous callback for wifiRing, NimBLE scan callback for
// bleRing), so head is ours alone to advance.
static inline void pushRecord(CapRing* r, uint8_t radio, uint8_t ch, int8_t rssi,
                              const uint8_t* payload, int len) {
    if (!r->slots || len < 0) return;
    uint32_t next = (r->head + 1) % r->n;
    if (next == r->tail) { r->drops++; return; }   // full: drop, don't block
    CapSlot* s = &r->slots[r->head];
    s->radio   = radio;
    s->seq     = r->seq++;
    s->ts      = micros();
    s->ch      = ch;
    s->rssi    = rssi;
    s->origLen = (uint16_t)len;
    int cap = len > CAP_MAX_BYTES ? CAP_MAX_BYTES : len;
    s->capLen = (uint16_t)cap;
    memcpy(s->data, payload, cap);
    r->head = next;
}

#if CONFIG_IDF_TARGET_ESP32C5
// The C5 driver hands promiscuous mode frames that failed reception (rx_state
// != 0). The S3 never delivered them. Captured on the bench they were random
// bytes: every type/subtype including reserved type 3, and ~3300 "unique"
// transmitters at home where the S3 saw 37. Drop them, and count them so the
// stat line shows how much noise was filtered.
static volatile uint32_t wifiBad = 0;
#endif

static void captureWifiCb(void* buf, wifi_promiscuous_pkt_type_t type) {
    if (!capturing) return;
    wifi_promiscuous_pkt_t* pkt = (wifi_promiscuous_pkt_t*)buf;
#if CONFIG_IDF_TARGET_ESP32C5
    if (pkt->rx_ctrl.rx_state != 0) { wifiBad++; return; }
#endif
    pushRecord(&wifiRing, 0, pkt->rx_ctrl.channel, (int8_t)pkt->rx_ctrl.rssi,
               pkt->payload, pkt->rx_ctrl.sig_len);
}

#if CONFIG_IDF_TARGET_ESP32C5
// env:c5 builds against NimBLE-Arduino 2.x, whose scan callback API changed.
class CaptureScanCallbacks : public NimBLEScanCallbacks {
    void onResult(const NimBLEAdvertisedDevice* dev) override {
        if (!capturing) return;
        uint8_t tmp[7 + 62];
        const NimBLEAddress& addr = dev->getAddress();
        const uint8_t* an = addr.getVal();      // 6 bytes, little-endian
        for (int i = 0; i < 6; i++) tmp[i] = an[5 - i];   // store big-endian MAC
        tmp[6] = addr.getType();
        const std::vector<uint8_t>& pd = dev->getPayload();   // reference, no copy
        int copy = (int)pd.size(); if (copy > (int)sizeof(tmp) - 7) copy = sizeof(tmp) - 7;
        for (int i = 0; i < copy; i++) tmp[7 + i] = pd[i];
        pushRecord(&bleRing, 1, 0, (int8_t)dev->getRSSI(), tmp, 7 + copy);
    }
};
#else
class CaptureScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice* dev) override {
        if (!capturing) return;
        uint8_t tmp[7 + 62];
        NimBLEAddress addr = dev->getAddress();
        const uint8_t* an = addr.getNative();   // 6 bytes, little-endian
        for (int i = 0; i < 6; i++) tmp[i] = an[5 - i];   // store big-endian MAC
        tmp[6] = addr.getType();
        int pl = dev->getPayloadLength();
        const uint8_t* pd = dev->getPayload();
        int copy = pl; if (copy > (int)sizeof(tmp) - 7) copy = sizeof(tmp) - 7;
        for (int i = 0; i < copy; i++) tmp[7 + i] = pd[i];
        pushRecord(&bleRing, 1, 0, (int8_t)dev->getRSSI(), tmp, 7 + copy);
    }
};
#endif
static CaptureScanCallbacks captureScanCallbacks;

static void emitSlot(const CapSlot* s) {
    uint8_t rec[CAP_HDR_BYTES + CAP_MAX_BYTES];
    rec[0] = s->radio;
    memcpy(rec + 1,  &s->seq, 4);
    memcpy(rec + 5,  &s->ts,  4);
    rec[9]  = s->ch;
    rec[10] = (uint8_t)s->rssi;
    memcpy(rec + 11, &s->origLen, 2);
    memcpy(rec + 13, &s->capLen,  2);
    memcpy(rec + 15, s->data, s->capLen);
    int reclen = CAP_HDR_BYTES + s->capLen;

    uint8_t b64[((CAP_HDR_BYTES + CAP_MAX_BYTES) * 4) / 3 + 8];
    size_t olen = 0;
    if (mbedtls_base64_encode(b64, sizeof(b64), &olen, rec, reclen) != 0) return;
    Serial.print("CAP:");
    Serial.write(b64, olen);
    Serial.print('\n');
}

static uint32_t drainRing(CapRing* r, uint32_t budget) {
    uint32_t n = 0;
    while (r->tail != r->head && n < budget) {
        emitSlot(&r->slots[r->tail]);
        r->tail = (r->tail + 1) % r->n;
        n++;
    }
    return n;
}

static void emitStat(bool done) {
    uint32_t now = millis();
    uint32_t remain = (capEndMs > now) ? (capEndMs - now) / 1000 : 0;
    char buf[160];
#if CONFIG_IDF_TARGET_ESP32C5
    snprintf(buf, sizeof(buf),
             "{\"cap\":{\"wifi\":%u,\"ble\":%u,\"drops\":%u,\"bad\":%u,\"remain\":%u,\"done\":%s}}",
             (unsigned)wifiRing.seq, (unsigned)bleRing.seq,
             (unsigned)(wifiRing.drops + bleRing.drops), (unsigned)wifiBad,
             (unsigned)remain, done ? "true" : "false");
#else
    snprintf(buf, sizeof(buf),
             "{\"cap\":{\"wifi\":%u,\"ble\":%u,\"drops\":%u,\"remain\":%u,\"done\":%s}}",
             (unsigned)wifiRing.seq, (unsigned)bleRing.seq,
             (unsigned)(wifiRing.drops + bleRing.drops),
             (unsigned)remain, done ? "true" : "false");
#endif
    Serial.println(buf);
}

static void captureHopTask(void*) {
#if CONFIG_IDF_TARGET_ESP32C5
    // Same schedule as the detector (c5_radio.h) for the band it is set to, so a
    // Site Survey capture hears what the detector hears.
    uint8_t ch[20];
    size_t n = c5BuildHop(getBand(), ch, sizeof(ch));
    size_t i = 0;
    while (capturing) {
        esp_wifi_set_channel(ch[i], WIFI_SECOND_CHAN_NONE);
        i = (i + 1) % n;
        vTaskDelay(pdMS_TO_TICKS(C5_HOP_DWELL_MS));
    }
#else
    static const uint8_t ch[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
    int i = 0;
    while (capturing) {
        esp_wifi_set_channel(ch[i], WIFI_SECOND_CHAN_NONE);
        i = (i + 1) % (int)(sizeof(ch) / sizeof(ch[0]));
        vTaskDelay(pdMS_TO_TICKS(250));   // 250 ms x 11 = ~2.75 s per full sweep
    }
#endif
    hopTaskHandle = NULL;
    vTaskDelete(NULL);
}

static void captureDrainTask(void*) {
    uint32_t lastStat = millis();
    while (true) {
        // Higher WiFi budget than BLE: WiFi is where the volume (and the target)
        // is. Bounded per pass so the stat/timer checks still run under load.
        drainRing(&wifiRing, 300);
        drainRing(&bleRing, 100);

        uint32_t now = millis();
        if (now - lastStat >= 1000) { lastStat = now; emitStat(false); }

        if (stopRequested || (capEndMs != 0 && now >= capEndMs)) {
            capturing = false;                       // stop producers
            esp_wifi_set_promiscuous(false);
            esp_wifi_set_promiscuous_rx_cb(NULL);
            NimBLEScan* sc = NimBLEDevice::getScan();
            if (sc) { sc->stop(); sc->clearResults(); }
            // Flush whatever is still queued before freeing.
            while (wifiRing.tail != wifiRing.head) drainRing(&wifiRing, 512);
            while (bleRing.tail  != bleRing.head)  drainRing(&bleRing, 512);
            emitStat(true);
            ringFree(&wifiRing);
            ringFree(&bleRing);
            needDetectorRestart = true;              // loop() resumes the detector
            drainTaskHandle = NULL;
            vTaskDelete(NULL);
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

void startCapture(uint32_t durationSecs) {
    if (capturing) return;

    stopWatchersWatch();   // capture owns the single promiscuous callback

    if (!ringAlloc(&wifiRing, WIFI_SLOTS) || !ringAlloc(&bleRing, BLE_SLOTS)) {
        ringFree(&wifiRing);
        ringFree(&bleRing);
        Serial.println("{\"cap\":{\"error\":\"psram alloc failed\"}}");
        startWatchersWatch();
        return;
    }

    stopRequested = false;
#if CONFIG_IDF_TARGET_ESP32C5
    wifiBad = 0;
#endif
    capEndMs = (durationSecs > 0) ? millis() + durationSecs * 1000UL : 0;
    capturing = true;

    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
#if CONFIG_IDF_TARGET_ESP32C5
    // A failed enable here silently degrades capture to 2.4 GHz-only with no
    // other witness -- this runs USB-only with a human watching, but the log
    // line is what tells them why 5 GHz never shows up.
    esp_err_t ccErr = esp_wifi_set_country_code(SWEEP_COUNTRY, true);   // gates legal 5 GHz channels
    if (ccErr != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_set_country_code failed: %s", esp_err_to_name(ccErr));
    }
    esp_err_t bmErr = esp_wifi_set_band_mode(WIFI_BAND_MODE_AUTO);
    if (bmErr != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_set_band_mode failed: %s", esp_err_to_name(bmErr));
    }
#endif
    wifi_promiscuous_filter_t f = { .filter_mask = WIFI_PROMIS_FILTER_MASK_ALL };
    esp_wifi_set_promiscuous_filter(&f);
    esp_wifi_set_promiscuous(true);
    esp_wifi_set_promiscuous_rx_cb(&captureWifiCb);

    NimBLEScan* sc = NimBLEDevice::getScan();
#if CONFIG_IDF_TARGET_ESP32C5
    sc->setScanCallbacks(&captureScanCallbacks, true);
#else
    sc->setAdvertisedDeviceCallbacks(&captureScanCallbacks, true);
#endif
    sc->setActiveScan(true);
#if CONFIG_IDF_TARGET_ESP32C5
    sc->setInterval(50);   // the detector's measured C5 BLE timing (c5_radio.h rationale)
    sc->setWindow(25);
    sc->start(0, false, true);
#else
    // The S3 time-slices ONE radio between BLE and WiFi, so the BLE scan window
    // is stolen straight from WiFi promiscuous. A near-100% window starved WiFi
    // to zero frames on the bench. WiFi is the priority target here, so give BLE
    // only ~40% -- still plenty of adverts, and WiFi actually gets heard.
    sc->setInterval(100);
    sc->setWindow(40);
    sc->start(0, nullptr, false);
#endif

#if CONFIG_IDF_TARGET_ESP32C5
    // Single core: xTaskCreatePinnedToCore(..., 1) asserts at boot. Same value as
    // hardware_manager.h's SWEEP_TASK_CORE -- not included here, since pulling
    // that header into this file adds hardware_manager.h/mode_manager.h tokens to
    // the S3 preprocessed output that the S3 gate rejects.
    xTaskCreatePinnedToCore(captureHopTask,   "CapHop",   4096, NULL, 1, &hopTaskHandle,   tskNO_AFFINITY);
    xTaskCreatePinnedToCore(captureDrainTask, "CapDrain", 8192, NULL, 2, &drainTaskHandle, tskNO_AFFINITY);
#else
    xTaskCreatePinnedToCore(captureHopTask,   "CapHop",   4096, NULL, 1, &hopTaskHandle,   1);
    xTaskCreatePinnedToCore(captureDrainTask, "CapDrain", 8192, NULL, 2, &drainTaskHandle, 1);
#endif

    Serial.printf("{\"cap\":{\"started\":true,\"secs\":%u}}\n", (unsigned)durationSecs);
    ESP_LOGI(TAG, "Capture started for %u s", (unsigned)durationSecs);
}

void stopCapture() {
    if (capturing) stopRequested = true;
}

bool isCapturing() {
    return capturing;
}

void captureTick() {
    if (needDetectorRestart) {
        needDetectorRestart = false;
        startWatchersWatch();
        ESP_LOGI(TAG, "Capture done, detector resumed");
    }
}
