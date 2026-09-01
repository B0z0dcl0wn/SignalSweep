#include "mode_sky_sweeper.h"
#include "ble_serial.h"
#include <NimBLEDevice.h>
#include <NimBLEScan.h>
#include <NimBLEAdvertisedDevice.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <ArduinoJson.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include "opendroneid.h"
#include "odid_wifi.h"
#include "hardware_manager.h"

static const char *TAG = "SkySweeper";

static SemaphoreHandle_t skySweeperMutex = NULL;
static bool skySweeperRunning = false;
static std::vector<SkySweeperTargetInfo> trackedDrones;
static TaskHandle_t channelHopperTaskHandle = NULL;

/**
 * @brief Thread-safe update or insertion of a detected drone target
 */
static void updateOrAddDroneTarget(const String& macStr, const ODID_UAS_Data& uasData, int rssi, const String& sourceStr) {
    if (skySweeperMutex == NULL) return;
    if (xSemaphoreTake(skySweeperMutex, pdMS_TO_TICKS(50)) != pdTRUE) return;

    uint32_t now = millis();
    bool found = false;

    // Identity is the UAS ID, not the MAC. Remote ID transmitters rotate their
    // MAC, so keying on it split one aircraft into a new target (and a fresh
    // triggerAlarm()) on every rotation. The UAS ID is the stable serial the
    // whole standard exists to broadcast; MAC is only the fallback for a frame
    // that carries no Basic ID yet.
    String incomingUasId = "";
    if (uasData.BasicIDValid[0] && strlen((const char*)uasData.BasicID[0].UASID) > 0) {
        incomingUasId = String((const char*)uasData.BasicID[0].UASID);
    }

    for (auto& drone : trackedDrones) {
        bool sameDrone = incomingUasId.length() > 0
            ? drone.uasId.equals(incomingUasId)
            : drone.mac.equalsIgnoreCase(macStr);
        if (sameDrone) {
            found = true;
            // Follow the aircraft across MAC rotations.
            drone.mac = macStr;
            drone.lastSeenMs = now;
            drone.count++;
            drone.rssi = rssi;
            drone.source = sourceStr;

            if (uasData.BasicIDValid[0] && strlen((const char*)uasData.BasicID[0].UASID) > 0) {
                drone.uasId = String((const char*)uasData.BasicID[0].UASID);
            }
            if (uasData.OperatorIDValid && strlen((const char*)uasData.OperatorID.OperatorId) > 0) {
                drone.operatorId = String((const char*)uasData.OperatorID.OperatorId);
            }
            if (uasData.SelfIDValid && strlen((const char*)uasData.SelfID.Desc) > 0) {
                drone.description = String((const char*)uasData.SelfID.Desc);
            }
            if (uasData.LocationValid) {
                drone.latitude = uasData.Location.Latitude;
                drone.longitude = uasData.Location.Longitude;
                drone.altitudeMsl = uasData.Location.AltitudeGeo;
                drone.heightAgl = uasData.Location.Height;
                drone.speed = uasData.Location.SpeedHorizontal;
                drone.heading = (int)uasData.Location.Direction;
            }
            if (uasData.SystemValid) {
                drone.operatorLatitude = uasData.System.OperatorLatitude;
                drone.operatorLongitude = uasData.System.OperatorLongitude;
            }
            break;
        }
    }

    if (!found) {
        SkySweeperTargetInfo newDrone;
        newDrone.mac = macStr;
        newDrone.rssi = rssi;
        newDrone.source = sourceStr;
        newDrone.firstSeenMs = now;
        newDrone.lastSeenMs = now;
        newDrone.count = 1;

        if (uasData.BasicIDValid[0] && strlen((const char*)uasData.BasicID[0].UASID) > 0) {
            newDrone.uasId = String((const char*)uasData.BasicID[0].UASID);
        } else {
            newDrone.uasId = "Unknown";
        }

        if (uasData.OperatorIDValid && strlen((const char*)uasData.OperatorID.OperatorId) > 0) {
            newDrone.operatorId = String((const char*)uasData.OperatorID.OperatorId);
        } else {
            newDrone.operatorId = "Unknown";
        }

        if (uasData.SelfIDValid && strlen((const char*)uasData.SelfID.Desc) > 0) {
            newDrone.description = String((const char*)uasData.SelfID.Desc);
        } else {
            newDrone.description = "";
        }

        if (uasData.LocationValid) {
            newDrone.latitude = uasData.Location.Latitude;
            newDrone.longitude = uasData.Location.Longitude;
            newDrone.altitudeMsl = uasData.Location.AltitudeGeo;
            newDrone.heightAgl = uasData.Location.Height;
            newDrone.speed = uasData.Location.SpeedHorizontal;
            newDrone.heading = (int)uasData.Location.Direction;
        } else {
            newDrone.latitude = 0.0;
            newDrone.longitude = 0.0;
            newDrone.altitudeMsl = 0.0f;
            newDrone.heightAgl = 0.0f;
            newDrone.speed = 0.0f;
            newDrone.heading = 0;
        }

        if (uasData.SystemValid) {
            newDrone.operatorLatitude = uasData.System.OperatorLatitude;
            newDrone.operatorLongitude = uasData.System.OperatorLongitude;
        } else {
            newDrone.operatorLatitude = 0.0;
            newDrone.operatorLongitude = 0.0;
        }

        trackedDrones.push_back(newDrone);
        ESP_LOGI(TAG, "New Drone Detected MAC: %s UAS ID: %s Source: %s",
                 newDrone.mac.c_str(), newDrone.uasId.c_str(), sourceStr.c_str());

        triggerAlarm();
    }

    xSemaphoreGive(skySweeperMutex);
}

/**
 * @brief NimBLE Scan Callbacks for processing BLE Open Drone ID (ODID) beacons
 */
class SkySweeperScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice* advertisedDevice) override {
        if (!skySweeperRunning) return;

        uint8_t* payload = advertisedDevice->getPayload();
        size_t len = advertisedDevice->getPayloadLength();
        if (!payload || len < 6) return;

        size_t offset = 0;
        bool isOdid = false;
        const uint8_t* odidData = nullptr;
        size_t odidLen = 0;

        while (offset + 1 < len) {
            uint8_t adLen = payload[offset];
            if (adLen == 0 || offset + 1 + adLen > len) break;
            uint8_t adType = payload[offset + 1];

            // AD Type 0x16 = Service Data - 16-bit UUID
            if (adType == 0x16 && adLen >= 3) {
                uint16_t uuid = payload[offset + 2] | (payload[offset + 3] << 8);
                // 0xFFFA = ASTM Remote ID Service UUID
                if (uuid == 0xFFFA) {
                    isOdid = true;
                    // Check if followed by Application Code (0x0D for Open Drone ID)
                    if (adLen >= 4 && payload[offset + 4] == 0x0D) {
                        odidData = &payload[offset + 5];
                        odidLen = adLen - 4;
                    } else {
                        odidData = &payload[offset + 4];
                        odidLen = adLen - 3;
                    }
                    break;
                }
            }
            offset += (adLen + 1);
        }

        if (!isOdid || !odidData || odidLen == 0) return;

        ODID_UAS_Data uasData;
        memset(&uasData, 0, sizeof(uasData));

        if ((odidData[0] & 0xF0) == (ODID_MESSAGETYPE_PACKED << 4)) {
            odid_message_process_pack(&uasData, (uint8_t*)odidData, odidLen);
        } else {
            decodeOpenDroneID(&uasData, (uint8_t*)odidData);
        }

        bool useful = uasData.BasicIDValid[0] || uasData.LocationValid ||
                      uasData.SystemValid || uasData.OperatorIDValid || uasData.SelfIDValid;
        if (!useful) return;

        String mac = String(advertisedDevice->getAddress().toString().c_str());
        mac.toUpperCase();

        updateOrAddDroneTarget(mac, uasData, advertisedDevice->getRSSI(), "BLE");
    }
};

static SkySweeperScanCallbacks scanCallbacks;

/**
 * @brief ESP32 Wi-Fi Promiscuous Mode RX Callback for WiFi ODID frames (Beacon & NAN Action)
 */
// Set by the promiscuous callback whenever the current channel yields a real
// ODID frame; the hopper grants that channel one extra dwell next cycle.
static volatile bool skyHitOnChannel = false;

static void wifiPromiscuousCallback(void* buf, wifi_promiscuous_pkt_type_t type) {
    if (!skySweeperRunning) return;
    if (type != WIFI_PKT_MGMT) return;

    wifi_promiscuous_pkt_t *packet = (wifi_promiscuous_pkt_t *)buf;
    uint8_t *payload = packet->payload;
    int length = packet->rx_ctrl.sig_len;
    int rssi = packet->rx_ctrl.rssi;

    if (!payload || length < 24) return;

    char macBuf[18];
    snprintf(macBuf, sizeof(macBuf), "%02X:%02X:%02X:%02X:%02X:%02X",
             payload[10], payload[11], payload[12],
             payload[13], payload[14], payload[15]);
    String senderMac = String(macBuf);

    ODID_UAS_Data uasData;
    memset(&uasData, 0, sizeof(uasData));

    // 1. WiFi NAN Action Frame detection (Destination MAC 51:6F:9A:01:00:00)
    static const uint8_t nanDest[6] = {0x51, 0x6F, 0x9A, 0x01, 0x00, 0x00};
    if (length >= 24 && memcmp(nanDest, &payload[4], 6) == 0) {
        char nanMacRaw[6] = {0};
        if (odid_wifi_receive_message_pack_nan_action_frame(&uasData, nanMacRaw, payload, length) == 0) {
            snprintf(macBuf, sizeof(macBuf), "%02X:%02X:%02X:%02X:%02X:%02X",
                     (uint8_t)nanMacRaw[0], (uint8_t)nanMacRaw[1], (uint8_t)nanMacRaw[2],
                     (uint8_t)nanMacRaw[3], (uint8_t)nanMacRaw[4], (uint8_t)nanMacRaw[5]);
            skyHitOnChannel = true;
            updateOrAddDroneTarget(String(macBuf), uasData, rssi, "WiFi NAN");
            return;
        }
    }

    // 2. WiFi Beacon Frame detection (Frame Control 0x80)
    if (payload[0] == 0x80 && length > 36) {
        int offset = 36; // IEs start after header (24B) + fixed parameters (12B)
        while (offset + 1 < length) {
            uint8_t ieType = payload[offset];
            uint8_t ieLen = payload[offset + 1];

            if (offset + 2 + ieLen > length) break;

            // Element ID 0xDD = Vendor Specific IE
            if (ieType == 0xDD && ieLen >= 5) {
                uint8_t oui0 = payload[offset + 2];
                uint8_t oui1 = payload[offset + 3];
                uint8_t oui2 = payload[offset + 4];

                // Known Remote ID OUIs: 90:3A:E6 (ASTM) or FA:0B:BC (French)
                if ((oui0 == 0x90 && oui1 == 0x3A && oui2 == 0xE6) ||
                    (oui0 == 0xFA && oui1 == 0x0B && oui2 == 0xBC)) {
                    
                    int dataStart = offset + 7; // IE type (1) + len (1) + OUI (3) + type (1) + count (1)
                    // Bound the payload by the IE's own length byte. This used
                    // to be `length - dataStart`, i.e. everything to the end of
                    // the frame, so the ODID decoder was fed the bytes of every
                    // subsequent IE plus the FCS as if they were drone data.
                    // The IE body ends at offset+2+ieLen; we start 5 bytes in
                    // (OUI 3 + type 1 + count 1), so ieLen - 5 bytes remain.
                    int dataLen = (int)ieLen - 5;
                    if (dataLen > 0 && dataStart + dataLen <= length) {
                        if ((payload[dataStart] & 0xF0) == (ODID_MESSAGETYPE_PACKED << 4)) {
                            odid_message_process_pack(&uasData, &payload[dataStart], dataLen);
                        } else {
                            decodeOpenDroneID(&uasData, &payload[dataStart]);
                        }

                        bool useful = uasData.BasicIDValid[0] || uasData.LocationValid ||
                                      uasData.SystemValid || uasData.OperatorIDValid || uasData.SelfIDValid;
                        if (useful) {
                            skyHitOnChannel = true;
                            updateOrAddDroneTarget(senderMac, uasData, rssi, "WiFi Beacon");
                        }
                    }
                }
            }
            offset += 2 + ieLen;
        }
    }
}

/**
 * @brief FreeRTOS task to cycle Wi-Fi channels (1, 6, 11) and push JSON periodically
 */
static void wifiChannelHopperTask(void *pvParameters) {
    (void)pvParameters;
    // Hop all US 2.4 GHz channels, not just 1/6/11: a drone's Remote ID WiFi
    // rides its operating channel, which can be any of them. 5 GHz Remote ID is
    // out of reach — the ESP32-S3 radio is 2.4 GHz only (a hardware limit).
    uint8_t channels[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
    uint8_t chIndex = 0;
    uint32_t lastPushTime = 0;

    // 250 ms x 11 channels was a 2.75 s cycle while BLE holds the shared radio
    // at 50% duty, so ~1 Hz Remote ID beacons were routinely missed on the
    // channel we weren't parked on. 150 ms halves the cycle; a channel that
    // actually produced an ODID frame earns one extra dwell so a live drone
    // isn't dropped just because its channel came up in the rotation.
    // ponytail: the real fix is the Tier 2 second radio (HAS_SECOND_RADIO),
    // which frees WiFi from sharing airtime with the BLE scan. This is interim.
    const uint32_t SKY_DWELL_MS = 150;

    while (skySweeperRunning) {
        // Channel hop across 2.4 GHz primary channels
        skyHitOnChannel = false;
        esp_wifi_set_channel(channels[chIndex], WIFI_SECOND_CHAN_NONE);
        chIndex = (chIndex + 1) % (sizeof(channels) / sizeof(channels[0]));

        vTaskDelay(pdMS_TO_TICKS(SKY_DWELL_MS));
        if (skyHitOnChannel && skySweeperRunning) {
            vTaskDelay(pdMS_TO_TICKS(SKY_DWELL_MS));   // sticky: stay on a productive channel
        }

        uint32_t now = millis();
        if (now - lastPushTime >= 1000) {
            lastPushTime = now;

            if (skySweeperMutex != NULL && xSemaphoreTake(skySweeperMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
                for (auto it = trackedDrones.begin(); it != trackedDrones.end(); ) {
                    if (now - it->lastSeenMs >= 30000) {
                        it = trackedDrones.erase(it);
                    } else {
                        ++it;
                    }
                }
                xSemaphoreGive(skySweeperMutex);
            }

            String jsonStr = getSkySweeperTargetsJson();
            sendBleSerial(jsonStr);
            Serial.println(jsonStr);
        }
    }

    channelHopperTaskHandle = NULL;
    vTaskDelete(NULL);
}

void startSkySweeper() {
    if (skySweeperMutex == NULL) {
        skySweeperMutex = xSemaphoreCreateMutex();
    }

    if (skySweeperMutex != NULL && xSemaphoreTake(skySweeperMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        if (skySweeperRunning) {
            xSemaphoreGive(skySweeperMutex);
            ESP_LOGW(TAG, "Sky Sweeper mode already active.");
            return;
        }
        skySweeperRunning = true;
        trackedDrones.clear();
        xSemaphoreGive(skySweeperMutex);
    }

    ESP_LOGI(TAG, "Starting Sky Sweeper mode...");

    // 1. Enable WiFi Promiscuous Mode for ODID Wi-Fi scanning (Station mode without AP)
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    wifi_promiscuous_filter_t wfilter = { .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT };
    esp_wifi_set_promiscuous_filter(&wfilter);
    esp_wifi_set_promiscuous(true);
    esp_wifi_set_promiscuous_rx_cb(&wifiPromiscuousCallback);

    // Create Wi-Fi Channel Hopper & Periodic Push Task on Core 0
    if (channelHopperTaskHandle == NULL) {
        xTaskCreatePinnedToCore(
            wifiChannelHopperTask,
            "SkyChannelHopper",
            4096,
            NULL,
            1,
            &channelHopperTaskHandle,
            0
        );
    }

    // 2. Start NimBLE scan for ODID BLE beacons
    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->setAdvertisedDeviceCallbacks(&scanCallbacks, true);
    // Passive: ASTM F3411 Remote ID rides entirely in the advertisement, so a
    // SCAN_REQ gains nothing and only announces this device to anything
    // listening for BLE scanners.
    pScan->setActiveScan(false);
    pScan->setInterval(100);
    pScan->setWindow(50);
    pScan->start(0, nullptr, false);

    ESP_LOGI(TAG, "Sky Sweeper active: BLE & WiFi Promiscuous scanning running.");
}

void stopSkySweeper() {
    if (skySweeperMutex != NULL && xSemaphoreTake(skySweeperMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        if (!skySweeperRunning) {
            xSemaphoreGive(skySweeperMutex);
            return;
        }
        skySweeperRunning = false;
        xSemaphoreGive(skySweeperMutex);
    }

    ESP_LOGI(TAG, "Stopping Sky Sweeper mode...");

    // 1. Stop NimBLE BLE scan
    NimBLEScan* pScan = NimBLEDevice::getScan();
    if (pScan) {
        pScan->stop();
        pScan->clearResults();
    }

    // 2. Disable Wi-Fi Promiscuous Mode properly
    esp_wifi_set_promiscuous_rx_cb(NULL);
    esp_wifi_set_promiscuous(false);

    ESP_LOGI(TAG, "Sky Sweeper mode stopped cleanly.");
}

bool isSkySweeperActive() {
    bool active = false;
    if (skySweeperMutex != NULL && xSemaphoreTake(skySweeperMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        active = skySweeperRunning;
        xSemaphoreGive(skySweeperMutex);
    }
    return active;
}

String getSkySweeperTargetsJson() {
    JsonDocument doc;
    doc["status"] = "success";
    doc["mode"] = 3;
    doc["name"] = "MODE_SKY_SWEEPER";

    if (skySweeperMutex != NULL && xSemaphoreTake(skySweeperMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        doc["count"] = trackedDrones.size();

        JsonArray targetsArr = doc["targets"].to<JsonArray>();
        for (const auto& t : trackedDrones) {
            JsonObject obj = targetsArr.add<JsonObject>();
            obj["mac"] = t.mac;
            obj["uas_id"] = t.uasId;
            obj["basic_id"] = t.uasId;
            obj["operator_id"] = t.operatorId;
            obj["description"] = t.description;
            obj["latitude"] = t.latitude;
            obj["drone_lat"] = t.latitude;
            obj["longitude"] = t.longitude;
            obj["drone_long"] = t.longitude;
            obj["altitude"] = t.altitudeMsl;
            obj["drone_altitude"] = t.altitudeMsl;
            obj["height"] = t.heightAgl;
            obj["speed"] = t.speed;
            obj["heading"] = t.heading;
            obj["operator_latitude"] = t.operatorLatitude;
            obj["pilot_lat"] = t.operatorLatitude;
            obj["operator_longitude"] = t.operatorLongitude;
            obj["pilot_long"] = t.operatorLongitude;
            obj["rssi"] = t.rssi;
            obj["source"] = t.source;
            obj["first_seen_ms"] = t.firstSeenMs;
            obj["last_seen_ms"] = t.lastSeenMs;
            obj["count"] = t.count;
        }
        xSemaphoreGive(skySweeperMutex);
    } else {
        doc["status"] = "error";
        doc["message"] = "Mutex acquisition timeout";
    }

    String output;
    serializeJson(doc, output);
    return output;
}
