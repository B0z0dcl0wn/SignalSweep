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
    prefs.begin("ouispy-hw", false);
    prefs.putInt("tier", getTier());
    prefs.end();
    ESP_LOGI(TAG, "Hardware tier: %d", getTier());

    // Boot straight into the detector — no selector, no mode queue.
    hardwareSetMode(MODE_WATCHERS_WATCH);
    startWatchersWatch();
    ESP_LOGI(TAG, "Detector started.");
}

void pauseBle(bool pause) {
    NimBLEScan* pScan = NimBLEDevice::getScan();
    if (pScan) {
        if (pause) {
            pScan->stop();
            ESP_LOGI(TAG, "BLE Scanning paused");
        } else {
            pScan->start(0, nullptr, false);
            ESP_LOGI(TAG, "BLE Scanning resumed");
        }
    }
}

void pauseWifi(bool pause) {
    esp_wifi_set_promiscuous(pause ? false : true);
    ESP_LOGI(TAG, "Wi-Fi Promiscuous Scanning %s", pause ? "paused" : "resumed");
}
