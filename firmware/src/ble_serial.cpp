#include "ble_serial.h"
#include "mode_manager.h"
#include "mode_beacon_bandit.h"
#include "mode_watchers_watch.h"
#include "mode_sky_sweeper.h"
#include <NimBLEDevice.h>
#include <ArduinoJson.h>
#include <esp_log.h>
#include "hardware_manager.h"

static const char *TAG = "BleSerial";

#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

static NimBLEServer *pServer = nullptr;
static NimBLECharacteristic *pTxCharacteristic = nullptr;
static NimBLECharacteristic *pRxCharacteristic = nullptr;
static bool deviceConnected = false;

/**
 * @brief (Re)start advertising the Nordic UART Service.
 *
 * The app discovers this device by the NUS service UUID, with a "SignalSweep"
 * name prefix as fallback (see requestDevice in app.js), so both have to be in
 * the advertisement for a connection to be possible at all.
 *
 * Do NOT call setAdvertisementData() here. It pushes its payload to the
 * controller immediately AND sets NimBLE's m_customAdvData flag, after which
 * start() skips building the advertisement from addServiceUUID()/name
 * (NimBLEAdvertising.cpp: `if (!m_customAdvData && !m_advDataSet)`). Passing it
 * an empty NimBLEAdvertisementData therefore advertises an empty payload — no
 * UUID, no name, nothing for the app to match, and no way to connect. That is
 * exactly what the old restoreBleSerialAdvertising() did; it only ever made
 * sense as a way to undo the ble_spoof custom payload, and ble_spoof is gone.
 *
 * ponytail: the second branch is kept live for CONFIG_BT_NIMBLE_EXT_ADV (BT5 /
 * Coded-PHY Remote ID scanning — see platformio.ini). It is NOT currently
 * enabled and is NOT known to work; finish and test it before turning the flag
 * on, because getting it wrong costs the control link to the whole device.
 */
static void startNusAdvertising() {
#if CONFIG_BT_NIMBLE_EXT_ADV
    NimBLEExtAdvertising *pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->stop(0);

    NimBLEExtAdvertisement adv;
    adv.setLegacyAdvertising(true);
    adv.setConnectable(true);
    adv.setScannable(true);
    adv.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
    adv.setCompleteServices(NimBLEUUID(SERVICE_UUID));

    // The name has to go in the scan response: flags (3 B) + a 128-bit service
    // UUID (18 B) + "SignalSweep" (13 B) = 34 B, over the 31-byte legacy PDU.
    NimBLEExtAdvertisement rsp;
    rsp.setLegacyAdvertising(true);
    rsp.setName("SignalSweep");

    pAdvertising->setInstanceData(0, adv);
    pAdvertising->setScanResponseData(0, rsp);
    pAdvertising->start(0);
#else
    NimBLEAdvertising *pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->stop();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);   // name rides in the scan response
    pAdvertising->start();
#endif
}

class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer) override {
        deviceConnected = true;
        ESP_LOGI(TAG, "BLE Client Connected");
        playConnectionChirp();
    }

    void onDisconnect(NimBLEServer* pServer) override {
        deviceConnected = false;
        ESP_LOGI(TAG, "BLE Client Disconnected - Restarting Advertising");
        playDisconnectionChirp();
        startNusAdvertising();
    }
};

void processIncomingCommand(const String& rawCommand) {
    if (rawCommand.length() == 0) return;

    ESP_LOGI(TAG, "Processing incoming command: %s", rawCommand.c_str());

    // Process incoming JSON payload or raw commands
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, rawCommand.c_str());

    if (!error) {
        // 1. Trigger mode change: {"mode": 1}, or a bare number "1" (which
        // parses as valid JSON, so it lands here rather than the raw fallback).
        // (raw-text "mode 1" for manual serial is handled in the fallback below)
        int modeVal = -1;
        if (doc["mode"].is<int>()) {
            modeVal = doc["mode"].as<int>();
        } else if (doc.is<int>()) {
            modeVal = doc.as<int>();
        }
        if (modeVal >= 0 && modeVal <= 4) {
            setOperatingMode(static_cast<OperatingMode>(modeVal));
            ESP_LOGI(TAG, "Command triggered mode change to: %d", modeVal);
        }

        // 2. Trigger target lock: {"lock": "AA:BB:CC:DD:EE:FF"} or bare {"mac": "..."}.
        // "mac" also carries the ble_write target (section 5), so only treat it
        // as a lock when there's no "action" — otherwise a ble_write spuriously
        // re-locks the target.
        if (!doc["action"].is<const char*>() && !doc["action"].is<String>() &&
            (doc["mac"].is<const char*>() || doc["mac"].is<String>())) {
            String targetMac = doc["mac"].as<String>();
            setBanditLockTarget(targetMac);
            ESP_LOGI(TAG, "Command set target lock MAC: %s", targetMac.c_str());
        } else if (doc["lock"].is<const char*>() || doc["lock"].is<String>()) {
            String targetMac = doc["lock"].as<String>();
            setBanditLockTarget(targetMac);
            ESP_LOGI(TAG, "Command set target lock MAC: %s", targetMac.c_str());
        }

        // 3. Trigger signature updates if signatures JSON object/array is received
        if (doc["signatures"].is<JsonArray>()) {
            updateWatchersSignaturesJson(rawCommand);
            ESP_LOGI(TAG, "Command updated signature rules database");
        }

        // 4. Toggle Beacon Bandit Filter
        if (doc["filter"].is<bool>()) {
            bool filterActive = doc["filter"].as<bool>();
            setBanditFilter(filterActive);
        }

        // 5. GATT write: backs the defensive "Ring/Find" action, which writes
        // the Immediate Alert Service (0x1802/0x2A06) to make a suspected
        // tracker chirp so it can be physically located.
        if (doc["action"].is<const char*>() || doc["action"].is<String>()) {
            String action = doc["action"].as<String>();

            if (action == "ble_write") {
                if (getCurrentMode() == MODE_BEACON_BANDIT) {
                    String targetMac = doc["mac"].as<String>();
                    String srv = doc["service"].as<String>();
                    String chr = doc["char"].as<String>();
                    String val = doc["val"].as<String>();
                    executeBleWrite(targetMac, srv, chr, val);
                } else {
                    ESP_LOGW(TAG, "ble_write is only allowed in Beacon Bandit mode.");
                }
            }
        }
    } else {
        // Raw text fallback parsing (e.g. "mode 1", "lock AA:BB:CC:DD:EE:FF").
        // Bare digits like "1" are valid JSON, so they're handled above, not here.
        String rawStr = rawCommand;
        rawStr.trim();

        if (rawStr.startsWith("mode ") || rawStr.startsWith("mode=")) {
            int modeVal = rawStr.substring(5).toInt();
            if (modeVal >= 0 && modeVal <= 4) {
                setOperatingMode(static_cast<OperatingMode>(modeVal));
                ESP_LOGI(TAG, "Raw string triggered mode change to: %d", modeVal);
            }
        } else if (rawStr.startsWith("lock ") || rawStr.startsWith("mac=")) {
            String targetMac = rawStr.substring(5);
            setBanditLockTarget(targetMac);
            ESP_LOGI(TAG, "Raw string set target lock MAC: %s", targetMac.c_str());
        } else if (rawStr == "CMD:SIGS:RESET") {
            // Restore the built-in signature rules, undoing a pushed rule set
            // without the full factory reset (which also wipes mode + lock).
            resetWatchersSignaturesToDefaults();
        } else if (rawStr == "CMD:BLE_SCAN:OFF") {
            pauseBle(true);
        } else if (rawStr == "CMD:BLE_SCAN:ON") {
            pauseBle(false);
        } else if (rawStr == "CMD:WIFI_SCAN:OFF") {
            pauseWifi(true);
        } else if (rawStr == "CMD:WIFI_SCAN:ON") {
            pauseWifi(false);
        }
    }
}

class RxCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *pCharacteristic) override {
        std::string rxValue = pCharacteristic->getValue();
        if (rxValue.length() > 0) {
            processIncomingCommand(String(rxValue.c_str()));
        }
    }
};

static ServerCallbacks serverCallbacks;
static RxCallbacks rxCallbacks;

void bleSerialInit() {
    ESP_LOGI(TAG, "Initializing BLE Serial Service (Nordic UART Service)...");

    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(&serverCallbacks);

    NimBLEService *pService = pServer->createService(SERVICE_UUID);

    // TX Characteristic (Notify)
    pTxCharacteristic = pService->createCharacteristic(
        CHARACTERISTIC_UUID_TX,
        NIMBLE_PROPERTY::NOTIFY
    );

    // RX Characteristic (Write / Write No Response)
    pRxCharacteristic = pService->createCharacteristic(
        CHARACTERISTIC_UUID_RX,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    pRxCharacteristic->setCallbacks(&rxCallbacks);

    pService->start();

    startNusAdvertising();

    ESP_LOGI(TAG, "BLE Nordic UART Service started and advertising.");
}

bool isBleSerialConnected() {
    return deviceConnected;
}

void sendBleSerial(const String& data) {
    if (pTxCharacteristic == nullptr) return;

    String payload = data + "\n";
    size_t length = payload.length();
    if (length == 0) return;

    // Send in chunks fitting within max MTU payload to ensure smooth notification delivery
    const size_t maxChunkSize = 180;
    if (length <= maxChunkSize) {
        pTxCharacteristic->setValue((const uint8_t*)payload.c_str(), length);
        pTxCharacteristic->notify();
    } else {
        size_t offset = 0;
        while (offset < length) {
            size_t chunkSize = (length - offset > maxChunkSize) ? maxChunkSize : (length - offset);
            pTxCharacteristic->setValue((const uint8_t*)(payload.c_str() + offset), chunkSize);
            pTxCharacteristic->notify();
            offset += chunkSize;
            if (offset < length) {
                vTaskDelay(pdMS_TO_TICKS(10));
            }
        }
    }
}
