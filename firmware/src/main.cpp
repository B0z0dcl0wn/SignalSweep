#include <Arduino.h>
#include "hardware_manager.h"
#include "ble_serial.h"
#include "mode_manager.h"
#include <NimBLEDevice.h>
#include <nvs_flash.h>

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

    // Initialize BLE stack
    NimBLEDevice::init("SignalSweep");

    // 1. Initialize Nordic UART Service (NUS) over NimBLE
    bleSerialInit();

    // 2. Initialize Mode Manager state machine & FreeRTOS task queue
    modeManagerInit();
}

void loop() {
    // Check if the BOOT button is pressed to reset to MODE_SELECTOR
    if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
        setOperatingMode(MODE_SELECTOR);
        // Debounce / wait for release
        while(digitalRead(BOOT_BUTTON_PIN) == LOW) {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }

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
