#include "mode_beacon_bandit.h"
#include "hardware_manager.h"
#include "ble_serial.h"
#include <NimBLEDevice.h>
#include <NimBLEScan.h>
#include <NimBLEAdvertisedDevice.h>
#include <NimBLEClient.h>
#include <ArduinoJson.h>
#include <esp_log.h>
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <algorithm>

static const char *TAG = "BeaconBandit";

static SemaphoreHandle_t banditMutex = NULL;
static bool banditRunning = false;
static bool banditFilterActive = true;
static String currentLockMac = "";
static std::vector<BanditTargetInfo> trackedTargets;
static TaskHandle_t banditTaskHandle = NULL;
static bool needsInterrogation = false;
static String targetToInterrogate = "";

/**
 * @brief Inspect advertised device properties and match against known beacon fingerprints
 */
static String checkFingerprint(NimBLEAdvertisedDevice* dev) {
    // 1. Check Device Name
    if (dev->haveName()) {
        String name = String(dev->getName().c_str());
        String nameLower = name;
        nameLower.toLowerCase();

        if (nameLower.indexOf("airtag") >= 0) return "Apple AirTag / Find My";
        if (nameLower.indexOf("ibeacon") >= 0) return "iBeacon";
        if (nameLower.indexOf("tile") >= 0) return "Tile Tracker";
        if (nameLower.indexOf("smarttag") >= 0) return "Samsung SmartTag";
        if (nameLower.indexOf("chipolo") >= 0) return "Chipolo Tracker";
        if (nameLower.indexOf("nut") >= 0) return "Nut Tracker";
        if (nameLower.indexOf("beacon") >= 0 || nameLower.indexOf("tracker") >= 0 || nameLower.indexOf("finder") >= 0) {
            return "Generic BLE Beacon";
        }
    }

    // 2. Check Service UUIDs
    if (dev->haveServiceUUID()) {
        size_t count = dev->getServiceUUIDCount();
        for (size_t i = 0; i < count; i++) {
            NimBLEUUID uuid = dev->getServiceUUID(i);
            String uuidStr = String(uuid.toString().c_str());
            uuidStr.toLowerCase();

            if (uuidStr.indexOf("fd6f") >= 0) return "Apple AirTag / Find My";
            if (uuidStr.indexOf("feed") >= 0 || uuidStr.indexOf("feec") >= 0) return "Tile Tracker";
            if (uuidStr.indexOf("fd69") >= 0) return "Samsung SmartTag";
            if (uuidStr.indexOf("fe2c") >= 0 || uuidStr.indexOf("fe2b") >= 0) return "Google Find My Device";
            if (uuidStr.indexOf("fe33") >= 0) return "Chipolo Tracker";
        }
    }

    // 3. Check Manufacturer Data
    if (dev->haveManufacturerData()) {
        std::string mfg = dev->getManufacturerData();
        if (mfg.length() >= 2) {
            uint16_t mfgId = (static_cast<uint8_t>(mfg[1]) << 8) | static_cast<uint8_t>(mfg[0]);
            
            // Apple Manufacturer ID = 0x004C
            if (mfgId == 0x004C) {
                if (mfg.length() >= 4 && static_cast<uint8_t>(mfg[2]) == 0x02 && static_cast<uint8_t>(mfg[3]) == 0x15) {
                    return "iBeacon";
                }
                if (mfg.length() >= 3) {
                    uint8_t subType = static_cast<uint8_t>(mfg[2]);
                    if (subType == 0x12 || subType == 0x07 || subType == 0x10 || subType == 0x15) {
                        return "Apple AirTag / Find My";
                    }
                }
                return "Apple BLE Device";
            }
            // Samsung Manufacturer ID = 0x0075
            else if (mfgId == 0x0075) {
                return "Samsung SmartTag";
            }
        }
    }

    return "";
}

/**
 * @brief Detect the Apple Find My "offline finding" broadcast (mfg 0x004C,
 * message type 0x12), which a tag sends when it is separated from its owner and
 * actively findable — i.e. the state that matters for stalking detection.
 * ponytail: keys on the message type, which AirGuard/OpenHaystack treat as the
 * separated indicator; the status byte's finer bits aren't needed here.
 */
static bool detectFindMySeparated(NimBLEAdvertisedDevice* dev) {
    if (!dev->haveManufacturerData()) return false;
    std::string mfg = dev->getManufacturerData();
    return mfg.length() >= 3 &&
           static_cast<uint8_t>(mfg[0]) == 0x4C &&
           static_cast<uint8_t>(mfg[1]) == 0x00 &&
           static_cast<uint8_t>(mfg[2]) == 0x12;
}

/**
 * @brief NimBLE Scan Callbacks for processing advertised devices
 */
class BanditScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice* advertisedDevice) override {
        if (!banditRunning) return;

        String mac = String(advertisedDevice->getAddress().toString().c_str());
        mac.toUpperCase();

        int rssi = advertisedDevice->getRSSI();
        uint32_t now = millis();

        // Lock check
        String lockTargetUpper = "";
        if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            lockTargetUpper = currentLockMac;
            xSemaphoreGive(banditMutex);
        }

        bool isLockTarget = (lockTargetUpper.length() > 0 && mac.equalsIgnoreCase(lockTargetUpper));
        String detectedType = checkFingerprint(advertisedDevice);

        // Ignore non-beacon devices unless they match the locked MAC or filter is off
        if (detectedType.length() == 0 && !isLockTarget) {
            if (banditFilterActive) {
                return;
            }
            detectedType = "Generic BLE Device";
        }

        if (detectedType.length() == 0 && isLockTarget) {
            detectedType = "Locked Target";
        }

        String devName = advertisedDevice->haveName() ? String(advertisedDevice->getName().c_str()) : "";

        if (isLockTarget) {
            ESP_LOGI(TAG, "[GEIGER LOCK] Prioritized RSSI update for %s: %d dBm", mac.c_str(), rssi);
            updateGeigerRssi(rssi);
        }

        // Thread-safe update of target list
        if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            bool found = false;
            for (auto& target : trackedTargets) {
                if (target.mac.equalsIgnoreCase(mac)) {
                    target.rssi = rssi;
                    target.lastSeenMs = now;
                    target.count++;
                    target.isLocked = isLockTarget;
                    target.addrType = advertisedDevice->getAddress().getType();
                    target.isSeparated = detectFindMySeparated(advertisedDevice);
                    if (devName.length() > 0) {
                        target.name = devName;
                    }
                    if (detectedType.length() > 0 && target.type == "Locked Target") {
                        target.type = detectedType;
                    }
                    found = true;
                    break;
                }
            }

            if (!found) {
                BanditTargetInfo newTarget;
                newTarget.mac = mac;
                newTarget.name = devName;
                newTarget.type = detectedType;
                newTarget.rssi = rssi;
                newTarget.firstSeenMs = now;
                newTarget.lastSeenMs = now;
                newTarget.count = 1;
                newTarget.isLocked = isLockTarget;
                newTarget.addrType = advertisedDevice->getAddress().getType();
                newTarget.isSeparated = detectFindMySeparated(advertisedDevice);
                trackedTargets.push_back(newTarget);

                ESP_LOGI(TAG, "New Target Discovered -> MAC: %s, Type: %s, RSSI: %d dBm", 
                         mac.c_str(), detectedType.c_str(), rssi);
            }
            xSemaphoreGive(banditMutex);
        }
    }
};

static BanditScanCallbacks scanCallbacks;

/**
 * @brief Periodic Task to push targets JSON once per second over BLE Serial & WebSerial
 */
static void banditPeriodicTask(void *pvParameters) {
    (void)pvParameters;
    while (banditRunning) {
        vTaskDelay(pdMS_TO_TICKS(2000));
        if (!banditRunning) break;

        bool interrogateNow = false;
        String interrogateMac = "";
        uint8_t interrogateAddrType = 0;
        
        if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            uint32_t now = millis();
            for (auto it = trackedTargets.begin(); it != trackedTargets.end(); ) {
                if ((now - it->lastSeenMs >= 30000) && !it->isLocked) {
                    it = trackedTargets.erase(it);
                } else {
                    ++it;
                }
            }

            if (needsInterrogation) {
                interrogateNow = true;
                interrogateMac = targetToInterrogate;
                needsInterrogation = false;
                for (const auto& t : trackedTargets) {
                    if (t.mac.equalsIgnoreCase(interrogateMac)) {
                        interrogateAddrType = t.addrType;
                        break;
                    }
                }
            }
            xSemaphoreGive(banditMutex);
        }

        if (interrogateNow) {
            ESP_LOGI(TAG, "Starting GATT Interrogation for %s (Type: %d)", interrogateMac.c_str(), interrogateAddrType);
            NimBLEScan* pScan = NimBLEDevice::getScan();
            pScan->stop();
            
            NimBLEAddress targetAddr(interrogateMac.c_str(), interrogateAddrType);
            NimBLEClient* pClient = NimBLEDevice::createClient();
            if (pClient->connect(targetAddr)) {
                ESP_LOGI(TAG, "Connected to %s! Ripping GATT table...", interrogateMac.c_str());
                
                JsonDocument doc;
                doc["event"] = "gatt_profile";
                doc["mac"] = interrogateMac;
                JsonArray servicesArr = doc["services"].to<JsonArray>();
                
                const auto* pServices = pClient->getServices(true);
                if (pServices != nullptr) {
                    for (auto pService : *pServices) {
                        JsonObject srvObj = servicesArr.add<JsonObject>();
                        srvObj["uuid"] = pService->getUUID().toString().c_str();
                        JsonArray charsArr = srvObj["characteristics"].to<JsonArray>();
                        
                        const auto* pChars = pService->getCharacteristics(true);
                        if (pChars != nullptr) {
                            for (auto pChar : *pChars) {
                                JsonObject charObj = charsArr.add<JsonObject>();
                                charObj["uuid"] = pChar->getUUID().toString().c_str();
                                
                                if (pChar->canRead()) {
                                    std::string val = pChar->readValue();
                                    String hexStr = "";
                                    String asciiStr = "";
                                    for (int i=0; i<val.length(); i++) {
                                        char buf[4];
                                        sprintf(buf, "%02X", (uint8_t)val[i]);
                                        hexStr += buf;
                                        if (val[i] >= 32 && val[i] <= 126) asciiStr += (char)val[i];
                                        else asciiStr += ".";
                                    }
                                    charObj["value_hex"] = hexStr;
                                    charObj["value_ascii"] = asciiStr;
                                }
                            }
                        }
                    }
                }
                
                String jsonStr;
                serializeJson(doc, jsonStr);
                sendBleSerial(jsonStr);
                if (Serial) Serial.println(jsonStr);   // skip the USB mirror when no host is attached
                
                pClient->disconnect();
            } else {
                ESP_LOGE(TAG, "Failed to connect to %s", interrogateMac.c_str());
            }
            NimBLEDevice::deleteClient(pClient);
            
            if (banditRunning) {
                pScan->start(0, nullptr, false);
            }
        }

        String jsonStr = getBanditTargetsJson();
        sendBleSerial(jsonStr);
        if (Serial) Serial.println(jsonStr);   // skip the USB mirror when no host is attached
    }
    banditTaskHandle = NULL;
    vTaskDelete(NULL);
}

void startBeaconBandit() {
    if (banditMutex == NULL) {
        banditMutex = xSemaphoreCreateMutex();
    }

    if (xSemaphoreTake(banditMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        if (banditRunning) {
            xSemaphoreGive(banditMutex);
            ESP_LOGW(TAG, "Beacon Bandit mode already active.");
            return;
        }
        banditRunning = true;
        trackedTargets.clear();
        
        // Restore locked target from NVS
        Preferences prefs;
        prefs.begin("ouispy-bandit", true);
        currentLockMac = prefs.getString("lock", "");
        prefs.end();
        
        if (currentLockMac.length() > 0) {
            setGeigerTargetLock(true, -90);
            ESP_LOGI(TAG, "Restored Bandit Lock Target: '%s'", currentLockMac.c_str());
        } else {
            currentLockMac = "";
        }
        
        xSemaphoreGive(banditMutex);
    }

    ESP_LOGI(TAG, "Starting NimBLE scanner for Beacon Bandit...");

    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->setAdvertisedDeviceCallbacks(&scanCallbacks, true);
    pScan->setActiveScan(true);
    pScan->setInterval(100);
    pScan->setWindow(50);

    pScan->start(0, nullptr, false);
    ESP_LOGI(TAG, "Beacon Bandit continuous BLE scan started successfully.");

    // Start periodic JSON broadcast task
    if (banditTaskHandle == NULL) {
        xTaskCreatePinnedToCore(
            banditPeriodicTask,
            "BanditPushTask",
            4096,
            NULL,
            1,
            &banditTaskHandle,
            1
        );
    }
}

void stopBeaconBandit() {
    if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        if (!banditRunning) {
            xSemaphoreGive(banditMutex);
            return;
        }
        banditRunning = false;
        xSemaphoreGive(banditMutex);
    }

    ESP_LOGI(TAG, "Stopping Beacon Bandit BLE scan...");
    setGeigerTargetLock(false, 0);
    NimBLEScan* pScan = NimBLEDevice::getScan();
    if (pScan) {
        pScan->stop();
        pScan->clearResults();
    }
    ESP_LOGI(TAG, "Beacon Bandit mode stopped.");
}

bool isBeaconBanditActive() {
    bool active = false;
    if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        active = banditRunning;
        xSemaphoreGive(banditMutex);
    }
    return active;
}

bool setBanditLockTarget(const String& mac) {
    String cleanMac = mac;
    cleanMac.trim();
    cleanMac.toUpperCase();

    if (cleanMac == "NONE" || cleanMac == "UNLOCK" || cleanMac == "CLEAR") {
        cleanMac = "";
    }

    if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        String oldLockMac = currentLockMac;
        currentLockMac = cleanMac;
        bool isLocked = (currentLockMac.length() > 0);
        
        if (isLocked && currentLockMac != oldLockMac) {
            needsInterrogation = true;
            targetToInterrogate = currentLockMac;
        }

        int lockRssi = -90;
        for (auto& t : trackedTargets) {
            t.isLocked = (isLocked && t.mac.equalsIgnoreCase(currentLockMac));
            if (t.isLocked) {
                lockRssi = t.rssi;
            }
        }
        setGeigerTargetLock(isLocked, lockRssi);
        
        // Save locked target to NVS for persistence across reboots
        Preferences prefs;
        prefs.begin("ouispy-bandit", false);
        prefs.putString("lock", currentLockMac);
        prefs.end();
        
        xSemaphoreGive(banditMutex);
        ESP_LOGI(TAG, "Beacon Bandit Lock Target set to: '%s'", currentLockMac.c_str());
        return true;
    }
    return false;
}

String getBanditLockTarget() {
    String locked = "";
    if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        locked = currentLockMac;
        xSemaphoreGive(banditMutex);
    }
    return locked;
}

String getBanditTargetsJson() {
    JsonDocument doc;
    doc["status"] = "success";
    doc["mode"] = 1;
    doc["name"] = "MODE_BEACON_BANDIT";

    if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        doc["locked_mac"] = currentLockMac;
        doc["count"] = trackedTargets.size();

        std::vector<BanditTargetInfo> sortedTargets = trackedTargets;
        std::sort(sortedTargets.begin(), sortedTargets.end(), [](const BanditTargetInfo& a, const BanditTargetInfo& b) {
            return a.rssi > b.rssi;
        });

        JsonArray targetsArr = doc["targets"].to<JsonArray>();
        for (const auto& t : sortedTargets) {
            JsonObject obj = targetsArr.add<JsonObject>();
            obj["mac"] = t.mac;
            obj["name"] = t.name;
            obj["type"] = t.type;
            obj["rssi"] = t.rssi;
            // first_seen_ms / last_seen_ms not sent: unread by the app,
            // which keeps its own wall-clock timing.
            obj["count"] = t.count;
            obj["is_locked"] = t.isLocked;

            // Stalking score: a tracker that lingers near you over time is the
            // signal. Persistence (duration) + repeat sightings + proximity +
            // Find My separated-state, per MAC. ponytail: per-MAC only — MAC
            // rotation (~15 min) breaks cross-rotation identity; tune weights.
            uint32_t durMs = (t.lastSeenMs >= t.firstSeenMs) ? (t.lastSeenMs - t.firstSeenMs) : 0;
            int durMin = (int)(durMs / 60000UL);
            int score = durMin * 8
                      + (t.count > 20 ? 20 : (int)t.count)
                      + (t.rssi > -70 ? 20 : 0)
                      + (t.isSeparated ? 35 : 0);
            if (score > 100) score = 100;

            obj["is_separated"] = t.isSeparated;
            // durMs still feeds the stalking score above; it just isn't sent,
            // because the app reads only stalking_score.
            obj["stalking_score"] = score;
        }
        xSemaphoreGive(banditMutex);
    } else {
        doc["status"] = "error";
        doc["message"] = "Mutex acquisition timeout";
    }

    String output;
    serializeJson(doc, output);
    return output;
}

void setBanditFilter(bool active) {
    if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        banditFilterActive = active;
        if (active) {
            // Clear out any Generic BLE Devices that were tracked while filter was off
            std::vector<BanditTargetInfo> filtered;
            for (const auto& t : trackedTargets) {
                if (t.type != "Generic BLE Device") {
                    filtered.push_back(t);
                }
            }
            trackedTargets = filtered;
        }
        xSemaphoreGive(banditMutex);
        ESP_LOGI(TAG, "Beacon Bandit filter set to: %s", active ? "ON" : "OFF");
    }
}

void executeBleWrite(const String& mac, const String& serviceUuid, const String& charUuid, const String& hexVal) {
    ESP_LOGI(TAG, "Executing BLE Write to %s...", mac.c_str());
    
    uint8_t targetAddrType = 0;
    if (banditMutex != NULL && xSemaphoreTake(banditMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        for (const auto& t : trackedTargets) {
            if (t.mac.equalsIgnoreCase(mac)) {
                targetAddrType = t.addrType;
                break;
            }
        }
        xSemaphoreGive(banditMutex);
    }

    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->stop();

    NimBLEAddress targetAddr(mac.c_str(), targetAddrType);
    NimBLEClient* pClient = NimBLEDevice::createClient();
    
    if (pClient->connect(targetAddr)) {
        NimBLERemoteService* pService = pClient->getService(serviceUuid.c_str());
        if (pService) {
            NimBLERemoteCharacteristic* pChar = pService->getCharacteristic(charUuid.c_str());
            if (pChar && (pChar->canWrite() || pChar->canWriteNoResponse())) {
                // Convert hex string to byte array
                size_t len = hexVal.length() / 2;
                uint8_t* payload = new uint8_t[len];
                for (size_t i = 0; i < len; i++) {
                    String byteStr = hexVal.substring(i * 2, i * 2 + 2);
                    payload[i] = (uint8_t) strtol(byteStr.c_str(), NULL, 16);
                }
                
                if (pChar->writeValue(payload, len, false)) {
                    ESP_LOGI(TAG, "Write successful!");
                } else {
                    ESP_LOGE(TAG, "Write failed!");
                }
                delete[] payload;
            }
        }
        pClient->disconnect();
    }
    
    NimBLEDevice::deleteClient(pClient);
    if (banditRunning) {
        pScan->start(0, nullptr, false);
    }
}
