#include "mode_watchers_watch.h"
#include "ble_serial.h"
#include <NimBLEDevice.h>
#include <NimBLEScan.h>
#include <NimBLEAdvertisedDevice.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <vector>
#include "hardware_manager.h"

static const char *TAG = "WatchersWatch";
static const char *SIG_FILE_PATH = "/data/signatures.json";

static SemaphoreHandle_t watchersMutex = NULL;
static bool watchersRunning = false;
static std::vector<WatcherSignature> loadedSignatures;
static std::vector<WatcherTargetInfo> trackedTargets;
static TaskHandle_t watchersTaskHandle = NULL;

/**
 * @brief Ensure /data/signatures.json exists on LittleFS, creating default rules if missing
 */
static void ensureSignaturesFileExists() {
    if (!LittleFS.exists(SIG_FILE_PATH)) {
        ESP_LOGI(TAG, "%s not found. Creating default signatures file...", SIG_FILE_PATH);
        if (!LittleFS.exists("/data")) {
            LittleFS.mkdir("/data");
        }
        File file = LittleFS.open(SIG_FILE_PATH, "w");
        if (file) {
            JsonDocument doc;
            JsonArray sigs = doc["signatures"].to<JsonArray>();

            auto addRule = [&](const char* name, const char* cat, const char* oui, const char* mfg, const char* dev, const char* uuid) {
                JsonObject s = sigs.add<JsonObject>();
                s["name"] = name;
                s["category"] = cat;
                s["oui"] = oui;
                s["mfg_id"] = mfg;
                s["device_name"] = dev;
                s["service_uuid"] = uuid;
            };

            // GoFlockYourself Extended OUIs
            const char* flockOuis[] = {
                "b4:1e:52", "70:c9:4e", "3c:91:80", "d8:f3:bc", "80:30:49", "b8:35:32",
                "14:5a:fc", "74:4c:a1", "08:3a:88", "9c:2f:9d", "c0:35:32", "94:08:53",
                "e4:aa:ea", "f4:6a:dd", "f8:a2:d6", "24:b2:b9", "00:f4:8d", "d0:39:57",
                "e8:d0:fc", "e0:4f:43", "b8:1e:a4", "70:08:94", "58:8e:81", "ec:1b:bd",
                "3c:71:bf", "58:00:e3", "90:35:ea", "5c:93:a2", "64:6e:69", "48:27:ea",
                "a4:cf:12", "82:6b:f2", "04:0d:84", "1c:34:f1", "38:5b:44", "94:34:69",
                "b4:e3:f9", "cc:cc:cc", "f0:82:c0", "e0:0a:f6"
            };
            for (const char* oui : flockOuis) {
                addRule("Flock Safety MAC", "Flock Safety", oui, "", "", "");
            }

            // SoundThinking / ShotSpotter
            addRule("SoundThinking", "SoundThinking", "d4:11:d6", "", "", "");

            // Raven UUIDs
            const char* ravenUuids[] = {"3100", "3200", "3300", "3400", "3500"};
            for (const char* uuid : ravenUuids) {
                addRule("Raven Surveillance", "Raven", "", "", "", uuid);
            }

            // Device Name Keywords
            const char* bleNames[] = {"flock", "raven", "penguin", "pigvision", "fs_"};
            for (const char* name : bleNames) {
                addRule("Flock BLE Name", "Flock Safety", "", "", name, "");
            }
            
            // XUNTONG Mfg ID
            addRule("Flock XUNTONG Mfg", "Flock Safety", "", "0x01", "", "");

            // Pre-existing SignalSweep Rules
            addRule("Flock Safety Mfg ID", "Flock Safety", "", "0x09C8", "", "");
            addRule("Axon Body Camera / Taser", "Axon", "00:25:df", "", "", "");
            addRule("Axon Signal System", "Axon", "", "", "", "fe6c");
            addRule("Axon Signal System", "Axon", "", "", "", "fe6d");
            addRule("Cradlepoint Router", "Fleet / Infrastructure", "00:30:44", "", "", "");
            addRule("Peplink Router", "Fleet / Infrastructure", "00:1a:dd", "", "", "");
            addRule("Sierra Wireless Infrastructure", "Fleet / Infrastructure", "00:21:b2", "", "", "");
            addRule("Sierra Wireless Infrastructure", "Fleet / Infrastructure", "00:f0:8a", "", "", "");
            addRule("Sierra Wireless Infrastructure", "Fleet / Infrastructure", "00:07:e2", "", "", "");

            serializeJsonPretty(doc, file);
            file.close();
            ESP_LOGI(TAG, "Default signatures created successfully.");
        } else {
            ESP_LOGE(TAG, "Failed to open %s for writing!", SIG_FILE_PATH);
        }
    }
}

/**
 * @brief Match an advertised device against a signature rule in memory
 */
static bool matchDeviceAgainstRule(NimBLEAdvertisedDevice* dev, const WatcherSignature& sig, String& outMatchedRule, String& outCategory) {
    bool hasCondition = false;

    // 1. Check OUI (MAC Prefix)
    if (sig.oui.length() > 0) {
        hasCondition = true;
        String mac = String(dev->getAddress().toString().c_str());
        String cleanMac = "";
        for (size_t i = 0; i < mac.length(); i++) {
            char c = mac[i];
            if (c != ':' && c != '-') cleanMac += (char)toupper(c);
        }
        String cleanOui = "";
        for (size_t i = 0; i < sig.oui.length(); i++) {
            char c = sig.oui[i];
            if (c != ':' && c != '-') cleanOui += (char)toupper(c);
        }

        if (!cleanMac.startsWith(cleanOui)) {
            return false;
        }
    }

    // 2. Check Manufacturer ID
    if (sig.mfgId.length() > 0) {
        hasCondition = true;
        if (!dev->haveManufacturerData()) {
            return false;
        }
        std::string mfg = dev->getManufacturerData();
        if (mfg.length() < 2) {
            return false;
        }
        uint16_t devMfgId = static_cast<uint8_t>(mfg[0]) | (static_cast<uint8_t>(mfg[1]) << 8);

        String mfgStr = sig.mfgId;
        mfgStr.trim();
        uint16_t targetMfgId = 0;
        if (mfgStr.startsWith("0x") || mfgStr.startsWith("0X")) {
            targetMfgId = static_cast<uint16_t>(strtoul(mfgStr.c_str(), NULL, 16));
        } else {
            targetMfgId = static_cast<uint16_t>(strtoul(mfgStr.c_str(), NULL, 0));
        }

        if (devMfgId != targetMfgId) {
            return false;
        }
    }

    // 3. Check Device Name Substring
    if (sig.deviceName.length() > 0) {
        hasCondition = true;
        if (!dev->haveName()) {
            return false;
        }
        String devName = String(dev->getName().c_str());
        devName.toLowerCase();
        String targetName = sig.deviceName;
        targetName.toLowerCase();

        if (devName.indexOf(targetName) < 0) {
            return false;
        }
    }

    // 4. Check Service UUID
    if (sig.serviceUuid.length() > 0) {
        hasCondition = true;
        if (!dev->haveServiceUUID()) {
            return false;
        }
        bool uuidMatched = false;
        size_t count = dev->getServiceUUIDCount();
        String targetUuid = sig.serviceUuid;
        targetUuid.toLowerCase();

        for (size_t i = 0; i < count; i++) {
            String uuidStr = String(dev->getServiceUUID(i).toString().c_str());
            uuidStr.toLowerCase();
            if (uuidStr.indexOf(targetUuid) >= 0) {
                uuidMatched = true;
                break;
            }
        }
        if (!uuidMatched) {
            return false;
        }
    }

    if (!hasCondition) {
        return false;
    }

    outMatchedRule = sig.name.length() > 0 ? sig.name : "Matched Signature";
    outCategory = sig.category.length() > 0 ? sig.category : "Surveillance";
    return true;
}

/**
 * @brief NimBLE Scan Callbacks for Watcher's Watch
 */
class WatchersScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice* advertisedDevice) override {
        if (!watchersRunning) return;

        if (watchersMutex == NULL) return;

        String mac = String(advertisedDevice->getAddress().toString().c_str());
        mac.toUpperCase();
        int rssi = advertisedDevice->getRSSI();
        uint32_t now = millis();
        String devName = advertisedDevice->haveName() ? String(advertisedDevice->getName().c_str()) : "";

        if (xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            String matchedRule = "";
            String matchedCategory = "";
            bool isMatch = false;

            for (const auto& sig : loadedSignatures) {
                if (matchDeviceAgainstRule(advertisedDevice, sig, matchedRule, matchedCategory)) {
                    isMatch = true;
                    break;
                }
            }

            if (isMatch) {
                bool found = false;
                for (auto& target : trackedTargets) {
                    if (target.mac.equalsIgnoreCase(mac)) {
                        target.rssi = rssi;
                        target.lastSeenMs = now;
                        target.count++;
                        target.protocol = "BLE";
                        if (devName.length() > 0) {
                            target.name = devName;
                        }
                        target.type = matchedCategory;
                        target.matchedRule = matchedRule;
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    WatcherTargetInfo newTarget;
                    newTarget.mac = mac;
                    newTarget.name = devName;
                    newTarget.type = matchedCategory;
                    newTarget.matchedRule = matchedRule;
                    newTarget.rssi = rssi;
                    newTarget.firstSeenMs = now;
                    newTarget.lastSeenMs = now;
                    newTarget.count = 1;
                    newTarget.protocol = "BLE";
                    trackedTargets.push_back(newTarget);

                    ESP_LOGI(TAG, "[SURVEILLANCE DETECTED] MAC: %s, Rule: %s, Category: %s, RSSI: %d dBm",
                             mac.c_str(), matchedRule.c_str(), matchedCategory.c_str(), rssi);
                    
                    if (matchedCategory.indexOf("Possible") >= 0) {
                        triggerWarning();
                    } else {
                        triggerAlarm();
                    }
                }
            }
            xSemaphoreGive(watchersMutex);
        }
    }
};

static WatchersScanCallbacks watchersScanCallbacks;

/**
 * @brief Periodic Task to push targets JSON once per second over BLE Serial & WebSerial
 */

static TaskHandle_t watchersWifiHopTaskHandle = NULL;

static void watchersWifiChannelHopperTask(void *pvParameters) {
    (void)pvParameters;
    const uint8_t channels[] = {1, 6, 11};
    int chIndex = 0;
    while (watchersRunning) {
        vTaskDelay(pdMS_TO_TICKS(150));
        if (!watchersRunning) break;
        esp_wifi_set_channel(channels[chIndex], WIFI_SECOND_CHAN_NONE);
        chIndex = (chIndex + 1) % 3;
    }
    watchersWifiHopTaskHandle = NULL;
    vTaskDelete(NULL);
}

static void watchersWifiPromiscuousCallback(void* buf, wifi_promiscuous_pkt_type_t type) {
    if (!watchersRunning) return;
    if (type != WIFI_PKT_MGMT) return;
    
    wifi_promiscuous_pkt_t *packet = (wifi_promiscuous_pkt_t *)buf;
    uint8_t *payload = packet->payload;
    int length = packet->rx_ctrl.sig_len;
    int rssi = packet->rx_ctrl.rssi;
    
    if (length < 24) return;
    
    uint8_t fc0 = payload[0];
    uint8_t ftype = (fc0 >> 2) & 0x03;
    uint8_t fsubtype = (fc0 >> 4) & 0x0F;
    
    uint8_t *addr1 = payload + 4;
    uint8_t *addr2 = payload + 10;
    
    // Probe Request (subtype 4) or Beacon (subtype 8) or Probe Response (subtype 5)
    if (ftype == 0 && (fsubtype == 4 || fsubtype == 5 || fsubtype == 8)) {
        if (watchersMutex == NULL) return;
        
        bool isFlock = false;
        String matchedRule = "";
        
        // 1. Check OUI
        String mac = "";
        char macBuf[20];
        snprintf(macBuf, sizeof(macBuf), "%02X:%02X:%02X:%02X:%02X:%02X", addr2[0], addr2[1], addr2[2], addr2[3], addr2[4], addr2[5]);
        mac = String(macBuf);
        String cleanMac = "";
        for (size_t i = 0; i < mac.length(); i++) {
            char c = mac[i];
            if (c != ':' && c != '-') cleanMac += (char)toupper(c);
        }
        
        if (xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            for (const auto& sig : loadedSignatures) {
                if (sig.oui.length() > 0) {
                    String cleanOui = "";
                    for (size_t i = 0; i < sig.oui.length(); i++) {
                        char c = sig.oui[i];
                        if (c != ':' && c != '-') cleanOui += (char)toupper(c);
                    }
                    if (cleanMac.startsWith(cleanOui)) {
                        isFlock = true;
                        matchedRule = sig.name.length() > 0 ? sig.name : "WiFi OUI Match";
                        break;
                    }
                }
            }
            xSemaphoreGive(watchersMutex);
        }
        
        // 2. Check LiteOn IE (0x221 length>=4 50 6F 9A)
        if (!isFlock && length > 24 + 12) {
            int offset = (fsubtype == 4) ? 24 : 36;
            int body_len = length - offset - 4; // -4 for FCS
            const uint8_t *body = payload + offset;
            
            int b = 0;
            while (b < body_len - 1) {
                uint8_t id = body[b];
                uint8_t elen = body[b+1];
                if (b + 2 + elen > body_len) break;
                
                // LiteOn IE
                if (id == 221 && elen >= 4 && body[b+2] == 0x50 && body[b+3] == 0x6F && body[b+4] == 0x9A) {
                    isFlock = true;
                    matchedRule = "Lite-On Flock Vendor IE";
                    break;
                }
                
                // SSID Check
                if (id == 0 && elen > 0 && elen <= 32) {
                    char ssid[33] = {0};
                    memcpy(ssid, body + b + 2, elen);
                    String ssidStr = String(ssid);
                    ssidStr.toLowerCase();
                    if (ssidStr.indexOf("flock") >= 0 || ssidStr.indexOf("fs_") >= 0 || ssidStr.indexOf("pigvision") >= 0) {
                        isFlock = true;
                        matchedRule = "Flock SSID Signature";
                        break;
                    }
                }
                
                b += 2 + elen;
            }
        }
        
        if (isFlock && xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            bool found = false;
            uint32_t now = millis();
            for (auto& target : trackedTargets) {
                if (target.mac.equalsIgnoreCase(mac)) {
                    target.rssi = rssi;
                    target.lastSeenMs = now;
                    target.count++;
                        target.protocol = "BLE";
                    target.type = "Flock Safety";
                    target.matchedRule = matchedRule;
                    target.protocol = "WiFi";
                    found = true;
                    break;
                }
            }
            if (!found) {
                WatcherTargetInfo newTarget;
                newTarget.mac = mac;
                newTarget.name = "Unknown Flock Node";
                newTarget.type = "Flock Safety";
                newTarget.matchedRule = matchedRule;
                newTarget.rssi = rssi;
                newTarget.firstSeenMs = now;
                newTarget.lastSeenMs = now;
                newTarget.count = 1;
                    newTarget.protocol = "BLE";
                newTarget.protocol = "WiFi";
                trackedTargets.push_back(newTarget);
                
                ESP_LOGI(TAG, "[SURVEILLANCE DETECTED - WIFI] MAC: %s, Rule: %s, RSSI: %d dBm", mac.c_str(), matchedRule.c_str(), rssi);
            }
            xSemaphoreGive(watchersMutex);
        }
    }
}

static void watchersPeriodicTask(void *pvParameters) {
    (void)pvParameters;
    while (watchersRunning) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (!watchersRunning) break;

        String jsonStr = getWatchersTargetsJson();
        sendBleSerial(jsonStr);
        Serial.println(jsonStr);
    }
    watchersTaskHandle = NULL;
    vTaskDelete(NULL);
}

void loadWatchersSignatures() {
    if (watchersMutex == NULL) {
        watchersMutex = xSemaphoreCreateMutex();
    }

    ensureSignaturesFileExists();

    File file = LittleFS.open(SIG_FILE_PATH, "r");
    if (!file) {
        ESP_LOGE(TAG, "Could not open %s for loading signatures", SIG_FILE_PATH);
        return;
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, file);
    file.close();

    if (error) {
        ESP_LOGE(TAG, "Failed to parse %s: %s", SIG_FILE_PATH, error.c_str());
        return;
    }

    if (xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        loadedSignatures.clear();
        JsonArray sigs;
        if (doc["signatures"].is<JsonArray>()) {
            sigs = doc["signatures"].as<JsonArray>();
        } else if (doc.is<JsonArray>()) {
            sigs = doc.as<JsonArray>();
        }

        for (JsonObject s : sigs) {
            WatcherSignature sig;
            sig.name = s["name"] | "";
            sig.category = s["category"] | "";
            sig.oui = s["oui"] | "";
            sig.mfgId = s["mfg_id"] | "";
            sig.deviceName = s["device_name"] | "";
            sig.serviceUuid = s["service_uuid"] | "";
            loadedSignatures.push_back(sig);
        }
        xSemaphoreGive(watchersMutex);
        ESP_LOGI(TAG, "Loaded %d Watcher signatures into memory.", (int)loadedSignatures.size());
    }
}

void startWatchersWatch() {
    if (watchersMutex == NULL) {
        watchersMutex = xSemaphoreCreateMutex();
    }

    if (xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        if (watchersRunning) {
            xSemaphoreGive(watchersMutex);
            ESP_LOGW(TAG, "Watcher's Watch mode already active.");
            return;
        }
        watchersRunning = true;
        trackedTargets.clear();
        xSemaphoreGive(watchersMutex);
    }

    loadWatchersSignatures();

    ESP_LOGI(TAG, "Starting NimBLE scanner for Watcher's Watch...");

    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->setAdvertisedDeviceCallbacks(&watchersScanCallbacks, true);
    pScan->setActiveScan(true);
    pScan->setInterval(100);
    pScan->setWindow(50);

    
    pScan->start(0, nullptr, false);
    
    // Start WiFi Promiscuous
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    esp_wifi_set_promiscuous(true);
    esp_wifi_set_promiscuous_rx_cb(&watchersWifiPromiscuousCallback);
    
    if (watchersWifiHopTaskHandle == NULL) {
        xTaskCreatePinnedToCore(
            watchersWifiChannelHopperTask,
            "WatchersWifiHop",
            4096,
            NULL,
            1,
            &watchersWifiHopTaskHandle,
            1
        );
    }

    ESP_LOGI(TAG, "Watcher's Watch continuous BLE scan started successfully.");

    // Start periodic JSON broadcast task
    if (watchersTaskHandle == NULL) {
        xTaskCreatePinnedToCore(
            watchersPeriodicTask,
            "WatchersPushTask",
            4096,
            NULL,
            1,
            &watchersTaskHandle,
            1
        );
    }
}

void stopWatchersWatch() {
    if (watchersMutex != NULL && xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        if (!watchersRunning) {
            xSemaphoreGive(watchersMutex);
            return;
        }
        watchersRunning = false;
        xSemaphoreGive(watchersMutex);
    }

    ESP_LOGI(TAG, "Stopping Watcher's Watch BLE scan...");
    NimBLEScan* pScan = NimBLEDevice::getScan();
    if (pScan) {
        pScan->stop();
        pScan->clearResults();
    }
    ESP_LOGI(TAG, "Watcher's Watch mode stopped.");
}

bool isWatchersWatchActive() {
    bool active = false;
    if (watchersMutex != NULL && xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        active = watchersRunning;
        xSemaphoreGive(watchersMutex);
    }
    return active;
}

String getWatchersTargetsJson() {
    JsonDocument doc;
    doc["status"] = "success";
    doc["mode"] = 2;
    doc["name"] = "MODE_WATCHERS_WATCH";

    if (watchersMutex != NULL && xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        doc["count"] = trackedTargets.size();

        JsonArray targetsArr = doc["targets"].to<JsonArray>();
        for (const auto& t : trackedTargets) {
            JsonObject obj = targetsArr.add<JsonObject>();
            obj["mac"] = t.mac;
            obj["name"] = t.name;
            obj["type"] = t.type;
            obj["matched_rule"] = t.matchedRule;
            obj["rssi"] = t.rssi;
            obj["first_seen_ms"] = t.firstSeenMs;
            obj["last_seen_ms"] = t.lastSeenMs;
            obj["count"] = t.count;
            obj["protocol"] = t.protocol.length() > 0 ? t.protocol : "BLE";
        }
        xSemaphoreGive(watchersMutex);
    } else {
        doc["status"] = "error";
        doc["message"] = "Mutex acquisition timeout";
    }

    String output;
    serializeJson(doc, output);
    return output;
}

String getWatchersSignaturesJson() {
    ensureSignaturesFileExists();

    File file = LittleFS.open(SIG_FILE_PATH, "r");
    if (!file) {
        return "{\"status\":\"error\",\"message\":\"Failed to open signatures file\"}";
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, file);
    file.close();

    if (error) {
        return "{\"status\":\"error\",\"message\":\"Corrupt signatures JSON file\"}";
    }

    if (doc.is<JsonObject>()) {
        doc["status"] = "success";
        String output;
        serializeJson(doc, output);
        return output;
    } else if (doc.is<JsonArray>()) {
        JsonDocument resDoc;
        resDoc["status"] = "success";
        resDoc["signatures"] = doc;
        String output;
        serializeJson(resDoc, output);
        return output;
    }

    return "{\"status\":\"error\",\"message\":\"Invalid JSON structure\"}";
}

bool updateWatchersSignaturesJson(const String& jsonContent) {
    if (watchersMutex == NULL) {
        watchersMutex = xSemaphoreCreateMutex();
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, jsonContent);
    if (error) {
        ESP_LOGE(TAG, "Failed to parse signature JSON input: %s", error.c_str());
        return false;
    }

    JsonArray sigs;
    if (doc["signatures"].is<JsonArray>()) {
        sigs = doc["signatures"].as<JsonArray>();
    } else if (doc.is<JsonArray>()) {
        sigs = doc.as<JsonArray>();
    } else {
        ESP_LOGE(TAG, "Invalid signatures format: missing 'signatures' array");
        return false;
    }

    if (!LittleFS.exists("/data")) {
        LittleFS.mkdir("/data");
    }

    File file = LittleFS.open(SIG_FILE_PATH, "w");
    if (!file) {
        ESP_LOGE(TAG, "Failed to open %s for writing", SIG_FILE_PATH);
        return false;
    }

    JsonDocument outDoc;
    JsonArray outSigs = outDoc["signatures"].to<JsonArray>();

    for (JsonObject s : sigs) {
        JsonObject ns = outSigs.add<JsonObject>();
        ns["name"] = s["name"] | "Unnamed Rule";
        ns["category"] = s["category"] | "Surveillance";
        ns["oui"] = s["oui"] | "";
        ns["mfg_id"] = s["mfg_id"] | "";
        ns["device_name"] = s["device_name"] | "";
        ns["service_uuid"] = s["service_uuid"] | "";
    }

    serializeJsonPretty(outDoc, file);
    file.close();

    ESP_LOGI(TAG, "Signatures updated successfully in %s", SIG_FILE_PATH);

    // Reload in memory dynamically
    loadWatchersSignatures();

    return true;
}
