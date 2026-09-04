// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include <Arduino.h>
#include "hardware_manager.h"
#include "ble_serial.h"
#include "mode_manager.h"
#include <NimBLEDevice.h>
#include <nvs_flash.h>
#include <LittleFS.h>

#define BOOT_BUTTON_PIN 0

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n=================================");
    Serial.println("   SignalSweep Firmware Booting   ");
    Serial.println("=================================");

    pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

    // 0. Initialize Hardware Manager (NeoPixel GPIO 21 & Buzzer GPIO 3)
    hardwareInit();

    // Initialize NVS properly before Bluetooth
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    // Mount LittleFS. Without this NOTHING filesystem-backed works: every
    // LittleFS.exists() returns false and every open() fails, so
    // ensureSignaturesFileExists() cannot write the defaults and
    // loadWatchersSignatures() bails out leaving loadedSignatures empty. That
    // silently disabled the entire Watcher's Watch signature database — every
    // OUI / device-name / service-UUID / manufacturer-ID rule was dead, and the
    // only detections that could fire were the two hardcoded checks in the
    // Wi-Fi callback. `true` formats on failure so a fresh board self-heals.
    if (!LittleFS.begin(true)) {
        Serial.println("[FS] LittleFS mount FAILED — signature rules unavailable.");
    } else {
        Serial.println("[FS] LittleFS mounted.");
    }

    // Initialize BLE stack under whatever identity is stored. Both the name
    // and the address have to be settled before init/advertising, which is why
    // changing either from the app reboots the board.
    String bleName = getBleDeviceName();
    NimBLEDevice::init(bleName.c_str());
    if (getRandomMacEnabled()) applyRandomMac();
    Serial.printf("[BLE] Advertising as '%s'%s\n", bleName.c_str(),
                  getRandomMacEnabled() ? " (random address this boot)" : "");

    // 1. Initialize Nordic UART Service (NUS) over NimBLE
    bleSerialInit();

    // 2. Persist hardware tier and start the always-on detector.
    modeManagerInit();
}

// Hold BOOT for this long to wipe the device back to factory defaults.
#define FACTORY_RESET_HOLD_MS 5000

/**
 * @brief Erase all persisted state (NVS namespaces + LittleFS) and reboot.
 *
 * Wipes the mode, the bandit target lock, the buzzer preference, the stored
 * tier, and /data/signatures.json. The tier is rewritten from the compile-time
 * flag on the next boot and signatures.json is recreated with defaults, so the
 * device comes back up as if freshly flashed.
 */
static void factoryReset() {
    Serial.println("[FACTORY RESET] Erasing NVS + LittleFS...");
    triggerLedFlash(255, 0, 0, 1500);
    nvs_flash_erase();
    LittleFS.format();
    Serial.println("[FACTORY RESET] Done. Rebooting.");
    Serial.flush();
    delay(200);
    ESP.restart();
}

void loop() {
    // BOOT button: hold 5s wipes to factory defaults (there is no selector to
    // tap back to anymore — one always-on detector). Red flash + warning tone
    // every second while held is the "let go now" signal; releasing early
    // aborts.
    if (rebootDue()) {
        Serial.println("[BLE] Identity changed — restarting.");
        Serial.flush();
        ESP.restart();
    }

    static uint32_t pressStartMs = 0;
    static uint32_t lastWarnSec = 0;

    if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
        if (pressStartMs == 0) {
            pressStartMs = millis();
            lastWarnSec = 0;
        }
        uint32_t heldMs = millis() - pressStartMs;

        if (heldMs >= FACTORY_RESET_HOLD_MS) {
            factoryReset();  // never returns
        }

        uint32_t heldSec = heldMs / 1000;
        if (heldSec > lastWarnSec) {
            lastWarnSec = heldSec;
            triggerLedFlash(255, 0, 0, 150);
            triggerWarning();
        }
    } else if (pressStartMs != 0) {
        uint32_t heldMs = millis() - pressStartMs;
        pressStartMs = 0;
        // A short tap is the way back in from receive-only with no cable at
        // all, which is the whole reason that mode needs no USB stack. Bounded
        // at 1 s so an aborted factory-reset hold isn't read as a tap, and it
        // never touches the long-press path above. No-op when already
        // advertising.
        if (heldMs < 1000) openAdvertisingWindow();
    }

    bleSerialTick();

    // Process incoming commands from USB Hardware Serial
    while (Serial.available()) {
        String cmd = Serial.readStringUntil('\n');
        cmd.trim();
        if (cmd.length() > 0) {
            processIncomingCommand(cmd);
        }
    }

    // Yield to free CPU resources for background tasks
    vTaskDelay(pdMS_TO_TICKS(10));
}
