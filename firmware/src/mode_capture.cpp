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

static const char* TAG = "Capture";

// The XIAO ESP32-C5 (env:c5) is single-core: pinning to core 1 asserts at boot.
#if CONFIG_IDF_TARGET_ESP32C5
#define CAP_CORE tskNO_AFFINITY
#else
#define CAP_CORE 1
#endif

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

// Hop-profile test, picked per capture (CMD:CAP:START:<secs>:<A-D>) so every
// variant runs on the same firmware. See captureHopTask.
static char capProfile = 'A';
static volatile uint32_t wifiLastNetMs = 0;   // last beacon/probe-resp heard
void setCaptureProfile(char p) { capProfile = ((p >= 'A' && p <= 'O') || p == 'T' || p == 'V' || p == 'W' || p == 'X') ? p : 'A'; }

// Hop markers: the hop task logs every channel set as a radio=2 record with a µs
// timestamp, so the analyzer can measure how long the radio is deaf after a
// band switch. Its own ring: producer = hop task, consumer = drain task (SPSC).
static CapRing hopRing = {};
#endif

static void captureWifiCb(void* buf, wifi_promiscuous_pkt_type_t type) {
    if (!capturing) return;
    wifi_promiscuous_pkt_t* pkt = (wifi_promiscuous_pkt_t*)buf;
#if CONFIG_IDF_TARGET_ESP32C5
    if (pkt->rx_ctrl.rx_state != 0) { wifiBad++; return; }
    if (type == WIFI_PKT_MGMT && (pkt->payload[0] == 0x80 || pkt->payload[0] == 0x50))
        wifiLastNetMs = millis();
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
#if CONFIG_IDF_TARGET_ESP32C5 && !defined(CAP_24_ONLY)
    // The C5 hears one band at a time and shares its one radio with the BLE
    // scan. Which hop hears the most is being measured, not guessed:
    //   A  every channel in order, 250 ms                  (Marauder-style)
    //   B  2.4 1-11 + non-DFS 5 GHz, 120 ms                (OUI Spy detector)
    //   C  1x 2.4 : 2x 5 GHz interleave, 300 ms on the busy channels, 110 ms
    //      elsewhere, leaving after 80 ms once 40 ms pass with no beacon
    //                                                      (OUI Spy wardrive)
    //   D  C's hop, BLE in 800 ms bursts every 3 s instead of a constant window
    // Round 2 separates what made B win (shorter dwell or no DFS):
    //   E  B's channels at A's 250 ms          (dwell only)
    //   F  A's channels at B's 120 ms          (channel set only)
    //   G  B's hop + D's BLE bursts            (BLE sharing on the best hop)
    // Round 3 keeps B's hop and varies only the BLE scan (B itself is 40/100):
    //   H  window 60 / interval 100
    //   I  window 30 / interval 50             (Marauder's wardrive setting)
    //   J  window 90 / interval 100
    // Round 4 hunts the balance point with short BLE slices (I is 30/50):
    //   K  window 20 / interval 50             (B's 40% BLE share, short slices)
    //   L  window 25 / interval 50             (50%)
    // Round 5 keeps L's BLE (25/50) and varies how much hop time 5 GHz gets:
    //   M  1-11, UNII-1, 1-11 again, UNII-3    (2.4 GHz twice per sweep)
    //   N  1-11 + UNII-3 (149-165) only        (fewer 5 GHz channels)
    //   O  1,3,5,7,9,11 + non-DFS 5 GHz        (every other 2.4 channel; relies on overlap)
    //   T  ch11 500 ms <-> ch161 500 ms        (deaf-time measurement with hop markers)
    //   V  park ch1, BLE 25/50                 (aliasing test: beacons vs coex slicing)
    //   W  park ch1, BLE scan OFF              (aliasing control)
    //   X  park ch6, BLE scan OFF              (moderate-level OFDM test vs the distant emitter)
    // ponytail: bench experiment; the winning profile replaces this switch.
    static const uint8_t c24[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
    static const uint8_t c5all[] = {36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116,
                                    120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165};
    static const uint8_t c5nd[] = {36, 40, 44, 48, 149, 153, 157, 161, 165};
    struct { uint8_t ch; uint16_t ms; } sched[48];
    int n = 0;
    const bool interleave = (capProfile == 'C' || capProfile == 'D');
    auto add = [&](const uint8_t* a, size_t len) {
        for (size_t k = 0; k < len && n < 48; k++) { sched[n].ch = a[k]; sched[n].ms = 120; n++; }
    };
    static const uint8_t u1[] = {36, 40, 44, 48};
    static const uint8_t u3[] = {149, 153, 157, 161, 165};
    static const uint8_t c24odd[] = {1, 3, 5, 7, 9, 11};
    if (capProfile == 'V' || capProfile == 'W') {
        sched[0].ch = 1; sched[0].ms = 500;
        n = 1;
    }
    else if (capProfile == 'X') {
        sched[0].ch = 6; sched[0].ms = 500;
        n = 1;
    }
    else if (capProfile == 'T') {
        sched[0].ch = 11;  sched[0].ms = 500;
        sched[1].ch = 161; sched[1].ms = 500;
        n = 2;
    }
    else if (capProfile == 'M') { add(c24, sizeof(c24)); add(u1, sizeof(u1)); add(c24, sizeof(c24)); add(u3, sizeof(u3)); }
    else if (capProfile == 'N') { add(c24, sizeof(c24)); add(u3, sizeof(u3)); }
    else if (capProfile == 'O') { add(c24odd, sizeof(c24odd)); add(c5nd, sizeof(c5nd)); }
    else if (!interleave) {
        const bool bHop       = (capProfile == 'B' || capProfile == 'G' || capProfile == 'H' ||
                                 capProfile == 'I' || capProfile == 'J' || capProfile == 'K' ||
                                 capProfile == 'L');
        const bool shortDwell = bHop || capProfile == 'F';
        const bool nonDfs     = bHop || capProfile == 'E';
        const uint16_t ms = shortDwell ? 120 : 250;
        for (uint8_t c : c24) { sched[n].ch = c; sched[n].ms = ms; n++; }
        if (nonDfs) { for (uint8_t c : c5nd)  { sched[n].ch = c; sched[n].ms = ms; n++; } }
        else        { for (uint8_t c : c5all) { sched[n].ch = c; sched[n].ms = ms; n++; } }
    } else {
        auto dwell = [](uint8_t c) -> uint16_t {
            return (c == 1 || c == 6 || c == 11 || c == 44 || c == 149 || c == 157) ? 300 : 110;
        };
        size_t i24 = 0, i5 = 0;
        while (n < 48 && (i24 < sizeof(c24) || i5 < sizeof(c5all))) {
            if (i24 < sizeof(c24)) { sched[n].ch = c24[i24]; sched[n].ms = dwell(c24[i24]); n++; i24++; }
            for (int b = 0; b < 2 && i5 < sizeof(c5all) && n < 48; b++) {
                sched[n].ch = c5all[i5]; sched[n].ms = dwell(c5all[i5]); n++; i5++;
            }
        }
    }
    NimBLEScan* sc = NimBLEDevice::getScan();
    uint32_t bleT = millis();
    bool bleOn = true;
    int i = 0;
    static const uint8_t noPayload = 0;
    while (capturing) {
        // radio=3 before the call, radio=2 after: the gap is how long the call blocks.
        // The before-marker is pushed first so its rssi byte can't carry the result;
        // the after-marker's rssi carries the return code's low byte (0 = ESP_OK).
        pushRecord(&hopRing, 3, sched[i].ch, 0, &noPayload, 0);
        esp_err_t hopErr = esp_wifi_set_channel(sched[i].ch, WIFI_SECOND_CHAN_NONE);
        pushRecord(&hopRing, 2, sched[i].ch, (int8_t)(hopErr & 0x7f), &noPayload, 0);   // hop marker
        uint32_t t0 = millis();
        if (!interleave) {
            vTaskDelay(pdMS_TO_TICKS(sched[i].ms));
        } else {
            wifiLastNetMs = t0;
            while (capturing) {
                vTaskDelay(pdMS_TO_TICKS(10));
                uint32_t now = millis();
                if (now - t0 >= sched[i].ms) break;
                if (now - t0 >= 80 && now - wifiLastNetMs >= 40) break;
            }
        }
        // ponytail: bursts toggle at hop boundaries, so on/off can run ~300 ms late
        if (capProfile == 'D' || capProfile == 'G') {
            uint32_t now = millis();
            if (bleOn && now - bleT >= 800) { sc->stop(); bleOn = false; }
            else if (!bleOn && now - bleT >= 3000 && capturing) { bleT = now; sc->start(0, false, true); bleOn = true; }
        }
        i = (i + 1) % n;
    }
    if (capProfile == 'D' || capProfile == 'G') sc->stop();   // a burst may have restarted after the drain task stopped it
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
#if CONFIG_IDF_TARGET_ESP32C5
        drainRing(&hopRing, 50);
#endif

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
#if CONFIG_IDF_TARGET_ESP32C5
            while (hopRing.tail  != hopRing.head)  drainRing(&hopRing, 512);
#endif
            emitStat(true);
            ringFree(&wifiRing);
            ringFree(&bleRing);
#if CONFIG_IDF_TARGET_ESP32C5
            ringFree(&hopRing);
#endif
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
    ringAlloc(&hopRing, 512);   // hop markers; if this fails, markers are just skipped
#endif
    capEndMs = (durationSecs > 0) ? millis() + durationSecs * 1000UL : 0;
    capturing = true;

    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
#if CONFIG_IDF_TARGET_ESP32C5
    esp_wifi_set_country_code(CAP_COUNTRY, true);   // gates legal 5 GHz channels
    esp_wifi_set_band_mode(WIFI_BAND_MODE_AUTO);
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
    // The S3 time-slices ONE radio between BLE and WiFi, so the BLE scan window
    // is stolen straight from WiFi promiscuous. A near-100% window starved WiFi
    // to zero frames on the bench. WiFi is the priority target here, so give BLE
    // only ~40% -- still plenty of adverts, and WiFi actually gets heard.
    sc->setInterval(100);
    sc->setWindow(40);
#if CONFIG_IDF_TARGET_ESP32C5
    if (capProfile == 'D' || capProfile == 'G') sc->setWindow(99);   // D/G: BLE in bursts, full window while on
    if (capProfile == 'H') sc->setWindow(60);                          // H: 60 / 100
    if (capProfile == 'I') { sc->setInterval(50); sc->setWindow(30); } // I: 30 / 50
    if (capProfile == 'J') sc->setWindow(90);                          // J: 90 / 100
    if (capProfile == 'K') { sc->setInterval(50); sc->setWindow(20); } // K: 20 / 50
    if (capProfile == 'L' || capProfile == 'M' || capProfile == 'N' || capProfile == 'O' || capProfile == 'T' ||
        capProfile == 'V' || capProfile == 'W') {
        sc->setInterval(50); sc->setWindow(25);                        // L, M, N, O: 25 / 50
    }
    if (capProfile != 'W' && capProfile != 'X') sc->start(0, false, true);   // W/X: no BLE scan
#else
    sc->start(0, nullptr, false);
#endif

    xTaskCreatePinnedToCore(captureHopTask,   "CapHop",   4096, NULL, 1, &hopTaskHandle,   CAP_CORE);
    xTaskCreatePinnedToCore(captureDrainTask, "CapDrain", 8192, NULL, 2, &drainTaskHandle, CAP_CORE);

#if CONFIG_IDF_TARGET_ESP32C5
    Serial.printf("{\"cap\":{\"started\":true,\"secs\":%u,\"profile\":\"%c\"}}\n", (unsigned)durationSecs, capProfile);
#else
    Serial.printf("{\"cap\":{\"started\":true,\"secs\":%u}}\n", (unsigned)durationSecs);
#endif
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
