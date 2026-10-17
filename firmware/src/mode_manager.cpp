// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "mode_manager.h"
#include "mode_watchers_watch.h"
#include "hardware_manager.h"
#include "ble_serial.h"
#include "capabilities.h"
#include <Preferences.h>
#include <esp_log.h>
#include <NimBLEDevice.h>
#include <esp_wifi.h>

static const char *TAG = "ModeManager";

// SignalSweep is one always-on detector now. The five-mode state machine (a
// FreeRTOS queue, a selector, per-mode NVS) was overhead on top of a single
// idea: match a known signature and beep. What survives here is the thin
// bootstrap — persist the hardware tier, start the detector — plus the
// radio pause hooks the BLE server uses while a client (dis)connects.
// OperatingMode stays as a type because the hardware manager keys its LED and
// jingle defaults off it; there is only ever one detection mode.

const char* getModeName(OperatingMode mode) {
    return "MODE_DETECTOR";
}

OperatingMode getCurrentMode() {
    return MODE_WATCHERS_WATCH;
}

bool setOperatingMode(OperatingMode newMode) {
    // No-op: there is only one mode. Kept so any stray caller still links.
    return true;
}

void modeManagerInit() {
    // Board self-ID: persist the compiled hardware tier so a future
    // flash.py --auto can read it back over serial (see capabilities.h).
    Preferences prefs;
    prefs.begin("sweep-hw", false);
    prefs.putInt("tier", getTier());
    prefs.end();
    ESP_LOGI(TAG, "Hardware tier: %d", getTier());

    // Boot straight into the detector — no selector, no mode queue.
    hardwareSetMode(MODE_WATCHERS_WATCH);
    startWatchersWatch();
    ESP_LOGI(TAG, "Detector started.");
}

// Every scan start/stop goes through these two, on both boards.
//
// Stop: with setMaxResults(0), NimBLE's stop() deletes every stored device on
// the CALLER's task (loop() for a USB command, the 1 Hz task for a ring) while
// the host task can be inside onResult reading one of them -- a use-after-free
// that panicked an S3 in findAdvField (2026-10-15). Raising the limit first
// makes stop() keep them; bleScanStart() clears them once nothing is scanning.
//
// Start (S3 only): scan in BLE_SCAN_ROUND_S rounds, restarted from the
// round-end callback. NimBLE 1.4 erases a device only after its callback fires,
// and for a scannable advert that waits for the scan response -- one that never
// comes (weak, MAC-rotating) stayed in the result vector for ever under a scan
// that never completes: -1.9 KB/h, 21 stuck devices in 1.45 h, BLE-only soak,
// leak followed the radio across boards. A round's end clears the vector on
// the host task, so no race. 2.x (C5) times those out itself: stays continuous.
#if !CONFIG_IDF_TARGET_ESP32C5
#define BLE_SCAN_ROUND_S 30
static volatile bool bleScanWanted = false;
static uint8_t bleScanIdleTicks = 0;

static void onScanRoundEnd(NimBLEScanResults) {
    // Also called by stop() on the caller's task; bleScanWanted is false then.
    if (bleScanWanted) NimBLEDevice::getScan()->start(BLE_SCAN_ROUND_S, onScanRoundEnd, true);
}
#endif

void bleScanStart() {
    NimBLEScan* sc = NimBLEDevice::getScan();
    sc->clearResults();          // safe: nothing is scanning yet
    sc->setMaxResults(0);
#if CONFIG_IDF_TARGET_ESP32C5
    sc->start(0, true, true);
#else
    bleScanWanted = true;
    bleScanIdleTicks = 0;
    sc->start(BLE_SCAN_ROUND_S, onScanRoundEnd, true);
#endif
}

void bleScanStop() {
    NimBLEScan* sc = NimBLEDevice::getScan();
#if !CONFIG_IDF_TARGET_ESP32C5
    bleScanWanted = false;
#endif
    sc->setMaxResults(0xFF);
    sc->stop();
    // ponytail: lets an in-flight onResult finish before anyone clears; a
    // handler is well under a millisecond.
    vTaskDelay(pdMS_TO_TICKS(20));
}

// 1 Hz safety net: a round restart that failed from the callback would leave
// the S3 BLE-deaf with nothing to say so. Two idle seconds in a row (a round
// boundary is microseconds) restarts it from here, where it is not scanning.
void bleScanTick() {
#if !CONFIG_IDF_TARGET_ESP32C5
    if (!bleScanWanted || NimBLEDevice::getScan()->isScanning()) { bleScanIdleTicks = 0; return; }
    if (++bleScanIdleTicks >= 2) {
        ESP_LOGW(TAG, "BLE scan round did not restart; restarting");
        bleScanStart();
    }
#endif
}

void pauseBle(bool pause) {
    if (pause) {
        bleScanStop();
        ESP_LOGI(TAG, "BLE Scanning paused");
    } else {
        bleScanStart();
        ESP_LOGI(TAG, "BLE Scanning resumed");
    }
}

void pauseWifi(bool pause) {
    esp_wifi_set_promiscuous(pause ? false : true);
    ESP_LOGI(TAG, "Wi-Fi Promiscuous Scanning %s", pause ? "paused" : "resumed");
}
