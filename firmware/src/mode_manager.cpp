#include "mode_manager.h"
#include "mode_beacon_bandit.h"
#include "mode_watchers_watch.h"
#include "mode_sky_sweeper.h"
#include "hardware_manager.h"
#include "ble_serial.h"
#include "capabilities.h"
#include <Preferences.h>
#include <ArduinoJson.h>
#include <esp_log.h>
#include <NimBLEDevice.h>
#include <esp_wifi.h>

static const char *TAG = "ModeManager";

static OperatingMode currentMode = MODE_SELECTOR;
static QueueHandle_t modeChangeQueue = NULL;
static TaskHandle_t modeManagerTaskHandle = NULL;

const char* getModeName(OperatingMode mode) {
    switch (mode) {
        case MODE_SELECTOR:       return "MODE_SELECTOR";
        case MODE_BEACON_BANDIT:  return "MODE_BEACON_BANDIT";
        case MODE_WATCHERS_WATCH: return "MODE_WATCHERS_WATCH";
        case MODE_SKY_SWEEPER:    return "MODE_SKY_SWEEPER";
        default:                  return "UNKNOWN_MODE";
    }
}

OperatingMode getCurrentMode() {
    return currentMode;
}

bool setOperatingMode(OperatingMode newMode) {
    if (modeChangeQueue == NULL) {
        ESP_LOGE(TAG, "Mode change queue not initialized!");
        return false;
    }
    
    if (xQueueSend(modeChangeQueue, &newMode, pdMS_TO_TICKS(100)) == pdPASS) {
        ESP_LOGI(TAG, "Mode change requested -> %s", getModeName(newMode));
        return true;
    }
    
    ESP_LOGE(TAG, "Failed to queue mode change -> %s", getModeName(newMode));
    return false;
}

static void shutdownCurrentMode(OperatingMode mode) {
    ESP_LOGI(TAG, "Cleanly shutting down previous mode: %s", getModeName(mode));
    switch (mode) {
        case MODE_BEACON_BANDIT:
            stopBeaconBandit();
            break;
        case MODE_WATCHERS_WATCH:
            stopWatchersWatch();
            break;
        case MODE_SKY_SWEEPER:
            stopSkySweeper();
            break;
        default:
            break;
    }
}

static void startNewMode(OperatingMode mode) {
    ESP_LOGI(TAG, "Starting new mode: %s", getModeName(mode));
    hardwareSetMode(mode);
    switch (mode) {
        case MODE_SELECTOR:
            ESP_LOGI(TAG, "Entering Selector Mode");
            break;
        case MODE_BEACON_BANDIT:
            ESP_LOGI(TAG, "Entering Beacon Bandit Mode");
            startBeaconBandit();
            break;
        case MODE_WATCHERS_WATCH:
            ESP_LOGI(TAG, "Entering Watchers Watch Mode");
            startWatchersWatch();
            break;
        case MODE_SKY_SWEEPER:
            ESP_LOGI(TAG, "Entering Sky Sweeper Mode");
            startSkySweeper();
            break;
    }
}

void ModeManagerTask(void *pvParameters) {
    (void)pvParameters;
    OperatingMode requestedMode;

    ESP_LOGI(TAG, "ModeManagerTask initialized. Starting in default mode: %s", getModeName(currentMode));
    startNewMode(currentMode);

    for (;;) {
        // Monitor FreeRTOS queue for mode change requests with 1000ms timeout
        if (xQueueReceive(modeChangeQueue, &requestedMode, pdMS_TO_TICKS(1000)) == pdTRUE) {
            if (requestedMode != currentMode) {
                ESP_LOGI(TAG, "Mode transition triggered: %s -> %s", 
                         getModeName(currentMode), getModeName(requestedMode));
                
                // Cleanly shut down previous mode without restarting ESP
                shutdownCurrentMode(currentMode);

                // Update current mode state
                currentMode = requestedMode;

                // Save new mode to non-volatile storage
                Preferences prefs;
                prefs.begin("ouispy-mode", false);
                prefs.putInt("mode", static_cast<int>(currentMode));
                prefs.end();

                // Start new mode
                startNewMode(currentMode);

                // Send immediate status notification via BLE Serial and WebSerial
                JsonDocument doc;
                doc["status"] = "success";
                doc["mode"] = static_cast<int>(currentMode);
                doc["name"] = getModeName(currentMode);
                String msg;
                serializeJson(doc, msg);
                sendBleSerial(msg);
                Serial.println(msg);
            } else {
                ESP_LOGI(TAG, "Already in mode %s, ignoring duplicate mode change request", getModeName(requestedMode));
            }
        } else {
            // Periodic status push when in MODE_SELECTOR (other modes have their own periodic tasks)
            if (currentMode == MODE_SELECTOR) {
                JsonDocument doc;
                doc["status"] = "success";
                doc["mode"] = 0;
                doc["name"] = getModeName(MODE_SELECTOR);
                doc["tier"] = getTier();
                String msg;
                serializeJson(doc, msg);
                sendBleSerial(msg);
                Serial.println(msg);
            }
        }
    }
}

void modeManagerInit() {
    // Load last saved mode from non-volatile storage
    Preferences prefs;
    prefs.begin("ouispy-mode", true);
    int savedMode = prefs.getInt("mode", MODE_SELECTOR);
    if (savedMode >= 0 && savedMode <= 3) {
        currentMode = static_cast<OperatingMode>(savedMode);
    }
    prefs.end();

    // Board self-ID: persist the compiled hardware tier so a future
    // flash.py --auto can read it back over serial (see capabilities.h).
    prefs.begin("ouispy-hw", false);
    prefs.putInt("tier", getTier());
    prefs.end();
    ESP_LOGI(TAG, "Hardware tier: %d", getTier());

    // Create FreeRTOS queue for mode change events
    modeChangeQueue = xQueueCreate(5, sizeof(OperatingMode));
    if (modeChangeQueue == NULL) {
        ESP_LOGE(TAG, "Failed to create mode change queue!");
        return;
    }

    // Create the ModeManager task on Core 1
    xTaskCreatePinnedToCore(
        ModeManagerTask,
        "ModeManagerTask",
        4096,
        NULL,
        1,
        &modeManagerTaskHandle,
        1
    );

    ESP_LOGI(TAG, "Mode Manager initialized successfully.");
}

void pauseBle(bool pause) {
    NimBLEScan* pScan = NimBLEDevice::getScan();
    if (pScan) {
        if (pause) {
            pScan->stop();
            ESP_LOGI(TAG, "BLE Scanning paused");
        } else {
            if (currentMode == MODE_WATCHERS_WATCH || currentMode == MODE_BEACON_BANDIT) {
                pScan->start(0, nullptr, false);
                ESP_LOGI(TAG, "BLE Scanning resumed");
            }
        }
    }
}

void pauseWifi(bool pause) {
    if (pause) {
        esp_wifi_set_promiscuous(false);
        ESP_LOGI(TAG, "Wi-Fi Promiscuous Scanning paused");
    } else {
        if (currentMode == MODE_SKY_SWEEPER) {
            esp_wifi_set_promiscuous(true);
            ESP_LOGI(TAG, "Wi-Fi Promiscuous Scanning resumed");
        }
    }
}
