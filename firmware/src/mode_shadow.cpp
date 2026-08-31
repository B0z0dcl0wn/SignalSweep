#include "mode_shadow.h"
#include "ble_serial.h"
#include "hardware_manager.h"
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
#include <vector>
#include <algorithm>

static const char *TAG = "Shadow";

static SemaphoreHandle_t shadowMutex = NULL;
static bool shadowRunning = false;
static std::vector<ShadowSighting> sightings;
static TaskHandle_t shadowTaskHandle = NULL;
static TaskHandle_t shadowHopTaskHandle = NULL;

// Shadow answers "is this device following me across locations?", which is a
// question about *persistence over space* — so the firmware stays dumb: report
// what it can hear, let the app (which has the GPS) do the correlation.
// ponytail: caps below keep the 1 Hz BLE-NUS push from drowning in a crowded
// RF environment. Raise SHADOW_MAX_REPORT if the link proves it can take it.
#define SHADOW_MAX_REPORT   40      // strongest N reported per push
#define SHADOW_MIN_COUNT    2       // ignore one-off blips (noise)
#define SHADOW_STALE_MS     120000  // drop devices unheard for 2 min

static void upsertSighting(const String& mac, const String& name, const char* proto, int rssi) {
    if (shadowMutex == NULL) return;
    if (xSemaphoreTake(shadowMutex, pdMS_TO_TICKS(10)) != pdTRUE) return;

    uint32_t now = millis();
    bool found = false;
    for (auto& s : sightings) {
        if (s.mac.equalsIgnoreCase(mac)) {
            s.rssi = rssi;
            s.lastSeenMs = now;
            s.count++;
            if (name.length() > 0) s.name = name;
            // A device heard on both radios is still one device; keep the label
            // honest rather than flip-flopping every packet.
            if (s.protocol != proto) s.protocol = "BLE+WiFi";
            found = true;
            break;
        }
    }

    if (!found) {
        ShadowSighting s;
        s.mac = mac;
        s.name = name;
        s.protocol = proto;
        s.rssi = rssi;
        s.firstSeenMs = now;
        s.lastSeenMs = now;
        s.count = 1;
        sightings.push_back(s);
    }
    xSemaphoreGive(shadowMutex);
}

class ShadowScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice* advertisedDevice) override {
        if (!shadowRunning) return;
        String mac = String(advertisedDevice->getAddress().toString().c_str());
        mac.toUpperCase();
        String name = advertisedDevice->haveName() ? String(advertisedDevice->getName().c_str()) : "";
        upsertSighting(mac, name, "BLE", advertisedDevice->getRSSI());
    }
};

static ShadowScanCallbacks shadowScanCallbacks;

/**
 * @brief Harvest transmitter MACs from WiFi management frames.
 * ponytail: MGMT only. Data frames would also expose *associated* client MACs
 * (which don't randomize, so they're the better tail signal), but they're far
 * higher volume — add WIFI_PKT_DATA here if the CPU budget allows.
 */
static void shadowWifiPromiscuousCallback(void* buf, wifi_promiscuous_pkt_type_t type) {
    if (!shadowRunning) return;
    if (type != WIFI_PKT_MGMT) return;

    wifi_promiscuous_pkt_t *packet = (wifi_promiscuous_pkt_t *)buf;
    uint8_t *payload = packet->payload;
    if (packet->rx_ctrl.sig_len < 24) return;

    uint8_t *addr2 = payload + 10;
    char macBuf[20];
    snprintf(macBuf, sizeof(macBuf), "%02X:%02X:%02X:%02X:%02X:%02X",
             addr2[0], addr2[1], addr2[2], addr2[3], addr2[4], addr2[5]);
    upsertSighting(String(macBuf), "", "WiFi", packet->rx_ctrl.rssi);
}

static void shadowWifiChannelHopperTask(void *pvParameters) {
    (void)pvParameters;
    const uint8_t channels[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
    int chIndex = 0;
    while (shadowRunning) {
        vTaskDelay(pdMS_TO_TICKS(150));
        if (!shadowRunning) break;
        esp_wifi_set_channel(channels[chIndex], WIFI_SECOND_CHAN_NONE);
        chIndex = (chIndex + 1) % (int)(sizeof(channels) / sizeof(channels[0]));
    }
    shadowHopTaskHandle = NULL;
    vTaskDelete(NULL);
}

static void shadowPeriodicTask(void *pvParameters) {
    (void)pvParameters;
    while (shadowRunning) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (!shadowRunning) break;

        // Prune stale devices so a long sweep doesn't grow without bound.
        if (shadowMutex != NULL && xSemaphoreTake(shadowMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
            uint32_t now = millis();
            sightings.erase(
                std::remove_if(sightings.begin(), sightings.end(),
                               [now](const ShadowSighting& s) {
                                   return (now - s.lastSeenMs) > SHADOW_STALE_MS;
                               }),
                sightings.end());
            xSemaphoreGive(shadowMutex);
        }

        String jsonStr = getShadowSightingsJson();
        sendBleSerial(jsonStr);
        Serial.println(jsonStr);
    }
    shadowTaskHandle = NULL;
    vTaskDelete(NULL);
}

void startShadow() {
    if (shadowRunning) return;

    if (shadowMutex == NULL) {
        shadowMutex = xSemaphoreCreateMutex();
    }
    if (shadowMutex != NULL && xSemaphoreTake(shadowMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        sightings.clear();
        xSemaphoreGive(shadowMutex);
    }

    shadowRunning = true;

    // BLE: continuous active scan
    NimBLEScan* pScan = NimBLEDevice::getScan();
    // wantDuplicates=true: report every advertisement, not one per MAC, so a
    // persistently-present device's count climbs (that's the whole signal here).
    pScan->setAdvertisedDeviceCallbacks(&shadowScanCallbacks, true);
    pScan->setActiveScan(true);
    pScan->setInterval(100);
    // 50% BLE window (not 99) leaves the shared radio airtime for WiFi
    // promiscuous — Shadow needs both, so it can't hog the radio for BLE.
    pScan->setWindow(50);
    pScan->start(0, nullptr, false);

    // WiFi: promiscuous + channel hop
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    esp_wifi_set_promiscuous(true);
    esp_wifi_set_promiscuous_rx_cb(&shadowWifiPromiscuousCallback);

    if (shadowHopTaskHandle == NULL) {
        xTaskCreatePinnedToCore(shadowWifiChannelHopperTask, "ShadowHop", 2048, NULL, 1, &shadowHopTaskHandle, 1);
    }
    if (shadowTaskHandle == NULL) {
        xTaskCreatePinnedToCore(shadowPeriodicTask, "ShadowTask", 8192, NULL, 1, &shadowTaskHandle, 1);
    }

    ESP_LOGI(TAG, "Shadow mode started (BLE + WiFi sighting harvest)");
}

void stopShadow() {
    if (!shadowRunning) return;
    shadowRunning = false;

    NimBLEScan* pScan = NimBLEDevice::getScan();
    if (pScan) {
        pScan->stop();
        pScan->setAdvertisedDeviceCallbacks(nullptr, false);
    }

    esp_wifi_set_promiscuous_rx_cb(NULL);
    esp_wifi_set_promiscuous(false);

    ESP_LOGI(TAG, "Shadow mode stopped");
}

bool isShadowActive() {
    return shadowRunning;
}

String getShadowSightingsJson() {
    JsonDocument doc;
    doc["status"] = "success";
    doc["mode"] = 4;
    doc["name"] = "MODE_SHADOW";

    if (shadowMutex != NULL && xSemaphoreTake(shadowMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        std::vector<ShadowSighting> report;
        for (const auto& s : sightings) {
            if (s.count >= SHADOW_MIN_COUNT) report.push_back(s);
        }
        std::sort(report.begin(), report.end(),
                  [](const ShadowSighting& a, const ShadowSighting& b) { return a.rssi > b.rssi; });
        if (report.size() > SHADOW_MAX_REPORT) report.resize(SHADOW_MAX_REPORT);

        doc["count"] = report.size();
        doc["total_seen"] = sightings.size();

        JsonArray arr = doc["targets"].to<JsonArray>();
        for (const auto& s : report) {
            JsonObject obj = arr.add<JsonObject>();
            obj["mac"] = s.mac;
            obj["name"] = s.name;
            obj["protocol"] = s.protocol;
            obj["rssi"] = s.rssi;
            obj["first_seen_ms"] = s.firstSeenMs;
            obj["last_seen_ms"] = s.lastSeenMs;
            obj["count"] = s.count;
        }
        xSemaphoreGive(shadowMutex);
    } else {
        doc["status"] = "error";
        doc["message"] = "Mutex acquisition timeout";
    }

    String output;
    serializeJson(doc, output);
    return output;
}
