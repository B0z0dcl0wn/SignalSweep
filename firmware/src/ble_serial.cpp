#include "ble_serial.h"
#include "mode_manager.h"
#include "mode_watchers_watch.h"
#include <NimBLEDevice.h>
#include <ArduinoJson.h>
#include <esp_log.h>
#include <Preferences.h>
#include <esp_random.h>
#include "hardware_manager.h"


// Declared rather than included: NimBLE-Arduino ships host/ble_hs_id.h inside
// its own source tree but does not put that directory on the consumer include
// path, so #include <host/ble_hs_id.h> does not resolve from src/.
extern "C" int ble_hs_id_set_rnd(const uint8_t *rnd_addr);

static const char *TAG = "BleSerial";

// ---- BLE identity ---------------------------------------------------------
// A user-set name lets you tell two boards apart in the connect dialog, and
// keeps "SignalSweep" off the air if you'd rather not announce what it is.
// The NUS service UUID is what the app actually filters on (see
// startNusAdvertising below), so renaming can't make the device undiscoverable.
#define BLE_ID_NVS_NS   "ouispy-ble"
#define BLE_NAME_MAX    20   // scan response is 31 B total; leave room for the header

static uint32_t rebootAtMs = 0;

String getBleDeviceName() {
    Preferences prefs;
    prefs.begin(BLE_ID_NVS_NS, true);
    String name = prefs.getString("name", "SignalSweep");
    prefs.end();
    if (name.length() == 0) name = "SignalSweep";
    return name;
}

bool getRandomMacEnabled() {
    Preferences prefs;
    prefs.begin(BLE_ID_NVS_NS, true);
    bool v = prefs.getBool("rndmac", false);
    prefs.end();
    return v;
}

// ---- Receive-only -------------------------------------------------------
// A counter-surveillance tool that advertises its own presence is backwards:
// anyone else running a scanner — including the hardware this exists to find —
// sees "SignalSweep" on the air. Receive-only stops advertising and drops the
// GATT link, leaving the BLE radio doing nothing but scanning.
//
// It is NOT "silent": that word already means the buzzer mute
// ({"buzzer":false}), which is a separate setting. The buzzer keeps working —
// that is the whole point of a headless detector. Nor is it fully passive:
// setActiveScan(true) stays on, because scan responses are where device names
// live and the name-matching signature rules depend on them.
//
// Lives in the BLE identity namespace rather than the detector's ouispy-st,
// because it is an emissions property of this radio, not operator state of the
// detector.
static bool rxOnly = false;          // cached; NVS is the source of truth at boot

bool getRxOnly() {
    return rxOnly;
}

void setBleIdentity(const String& name, bool randomMac) {
    String clean;
    for (size_t i = 0; i < name.length() && clean.length() < BLE_NAME_MAX; i++) {
        char c = name[i];
        // Printable ASCII only. The name goes straight into an advertisement
        // and then into the phone's device picker; control bytes have no
        // business in either.
        if (c >= 0x20 && c < 0x7F) clean += c;
    }
    clean.trim();

    Preferences prefs;
    prefs.begin(BLE_ID_NVS_NS, false);
    if (clean.length() > 0) prefs.putString("name", clean);
    else                    prefs.remove("name");   // back to the default
    prefs.putBool("rndmac", randomMac);
    prefs.end();
    ESP_LOGI(TAG, "BLE identity set: name='%s' randomMac=%d",
             clean.length() ? clean.c_str() : "SignalSweep", (int)randomMac);
}

void applyRandomMac() {
    // A random *static* address, not a resolvable private one: NimBLE's RPA
    // path is compiled out unless BLE_HOST_BASED_PRIVACY is enabled, whereas
    // this works on the stock config. "Static" means fixed for this boot, which
    // is exactly the promise — a new identity every power cycle.
    // The two most significant bits of a random static address must be 1.
    uint8_t addr[6];
    esp_fill_random(addr, sizeof(addr));
    addr[5] |= 0xC0;

    int rc = ble_hs_id_set_rnd(addr);
    if (rc != 0) {
        ESP_LOGW(TAG, "ble_hs_id_set_rnd failed (rc=%d) — keeping factory address", rc);
        return;
    }
    NimBLEDevice::setOwnAddrType(BLE_OWN_ADDR_RANDOM);
    ESP_LOGI(TAG, "Random BLE address for this boot: %02X:%02X:%02X:%02X:%02X:%02X",
             addr[5], addr[4], addr[3], addr[2], addr[1], addr[0]);
}

// Whether the operator has paused a radio from the app. Deliberately NOT read
// out of pauseBle()/pauseWifi(): performRing() pauses the BLE scan for the
// duration of a ring, and reporting that would show the scanner as off for a
// second every time you ring a tracker. Not persisted, like scan_all — a reboot
// always comes back with both radios scanning.
static bool bleScanOn  = true;
static bool wifiScanOn = true;

String getBleConfigJson() {
    JsonDocument doc;
    doc["cfg"] = true;
    doc["ble_name"] = getBleDeviceName();
    doc["rand_mac"] = getRandomMacEnabled();
    // Operator state, so a phone connecting to a board that has been running
    // headless learns what it was already doing rather than assuming defaults.
    doc["hunt"] = getHuntTarget();
    doc["scan_all"] = getScanAll();
    // Bitmask, not a counter -- "alerts" below is the alert count.
    doc["beep_mask"] = getBeepMask();
    doc["rx_only"] = rxOnly;
    doc["ble_scan"] = bleScanOn;
    doc["wifi_scan"] = wifiScanOn;
    doc["alerts"] = getAlertCount();
    String out;
    serializeJson(doc, out);
    return out;
}

// Reply on both transports. sendBleSerial() deliberately returns early with no
// client subscribed, so a BLE-only reply is invisible over USB — which makes the
// identity commands untestable from a serial console, the one place you'd reach
// for when the BLE name is what you're trying to fix.
static void sendConfigReply() {
    String cfg = getBleConfigJson();
    sendBleSerial(cfg);
    if (Serial) Serial.println(cfg);
}

void requestReboot() {
    // Long enough for the notify queue to drain to a connected phone; short
    // enough that it feels like the setting applied immediately.
    rebootAtMs = millis() + 600;
}

bool rebootDue() {
    return rebootAtMs != 0 && (int32_t)(millis() - rebootAtMs) >= 0;
}

#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

static NimBLEServer *pServer = nullptr;
static NimBLECharacteristic *pTxCharacteristic = nullptr;
static NimBLECharacteristic *pRxCharacteristic = nullptr;
static bool deviceConnected = false;

// Negotiated ATT MTU. 23 is the BLE default and the only safe assumption until
// the peer tells us otherwise; phones routinely negotiate 247 or more, which is
// worth roughly 3x fewer notifications for the same payload.
static uint16_t negotiatedMtu = 23;

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

// Set while a short BOOT press has re-opened advertising temporarily. Zero
// means no window is open. Deliberately transient: see setRxOnly().
// Two minutes is long enough to fish the phone out of a pocket and pick the
// device from the connect dialog, short enough that an accidental press is not
// an afternoon of broadcasting.
#define ADV_WINDOW_MS 120000
static uint32_t advWindowEndMs = 0;

static void setRxOnly(bool quiet, bool announce);

class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer) override {
        deviceConnected = true;
        ESP_LOGI(TAG, "BLE Client Connected");
        playConnectionChirp();
        // Someone actually connected during the re-advertise window, so this is
        // a deliberate un-quieting rather than a stray button press. Clear the
        // flag properly instead of dropping the link when the window expires.
        if (advWindowEndMs != 0) {
            advWindowEndMs = 0;
            setRxOnly(false, false);   // already chirped on connect
        }
    }

    void onMTUChange(uint16_t MTU, ble_gap_conn_desc* desc) override {
        negotiatedMtu = MTU;
        ESP_LOGI(TAG, "Peer MTU negotiated: %u", (unsigned)MTU);
    }

    void onDisconnect(NimBLEServer* pServer) override {
        deviceConnected = false;
        negotiatedMtu = 23;   // next peer renegotiates from scratch
        playDisconnectionChirp();
        // THE trap. This call used to be unconditional, which means the instant
        // receive-only dropped the client the device advertised itself again —
        // going quiet would have been visibly, silently broken.
        if (rxOnly) {
            ESP_LOGI(TAG, "BLE Client Disconnected - staying quiet (receive-only)");
            return;
        }
        ESP_LOGI(TAG, "BLE Client Disconnected - Restarting Advertising");
        startNusAdvertising();
    }
};

/**
 * @brief Enter or leave receive-only.
 *
 * Entering: persist, acknowledge while the link is still up, then stop
 * advertising and drop any connected client. The reply has to go first —
 * once the link is gone there is no way to tell the app the command landed,
 * and an app that never heard back just sits there reconnecting.
 *
 * Leaving: persist, then advertise. startNusAdvertising() stays the ONLY place
 * advertising is ever started (see its comment); this adds no second path and
 * never touches setAdvertisementData().
 */
static void setRxOnly(bool quiet, bool announce) {
    rxOnly = quiet;
    Preferences prefs;
    if (prefs.begin(BLE_ID_NVS_NS, false)) {
        prefs.putBool("rxonly", quiet);
        prefs.end();
    } else {
        ESP_LOGW(TAG, "Could not persist rx_only — it will not survive a reboot");
    }

    if (quiet) {
        // Acknowledge while the link is still up and with the new flag value
        // already set, so the app records what actually happened.
        sendConfigReply();
        advWindowEndMs = 0;
        NimBLEDevice::getAdvertising()->stop();
        if (pServer) {
            for (uint16_t id : pServer->getPeerDevices()) {
                pServer->disconnect(id);
            }
        }
        // Descending chirp + a blue idle blink. Receive-only is invisible by
        // definition, and a device that looks broken is worse than one that is.
        if (announce) playDisconnectionChirp();
        setRxOnlyIndicator(true);
        ESP_LOGI(TAG, "Receive-only ON — advertising stopped, still scanning");
    } else {
        setRxOnlyIndicator(false);
        if (announce) playConnectionChirp();
        // Not while a client is already on the link: the controller stops
        // advertising on connect, and restarting it here would only offer the
        // device to a second peer.
        if (!deviceConnected) startNusAdvertising();
        ESP_LOGI(TAG, "Receive-only OFF — advertising");
    }
}

void openAdvertisingWindow() {
    if (!rxOnly) return;   // already discoverable; nothing to do
    advWindowEndMs = millis() + ADV_WINDOW_MS;
    triggerLedFlash(0, 120, 255, 400);
    playConnectionChirp();
    startNusAdvertising();
    ESP_LOGI(TAG, "Advertising window open for %u s", (unsigned)(ADV_WINDOW_MS / 1000));
}

void bleSerialTick() {
    // Close the window. A press in the field must not leave the device
    // broadcasting for the rest of the day — that would silently defeat the
    // only reason receive-only exists. A client that connected in time already
    // cleared rxOnly in onConnect, so this only fires when nobody came.
    if (advWindowEndMs == 0) return;
    if (deviceConnected) return;
    if ((int32_t)(millis() - advWindowEndMs) < 0) return;
    advWindowEndMs = 0;
    NimBLEDevice::getAdvertising()->stop();
    playDisconnectionChirp();
    ESP_LOGI(TAG, "Advertising window expired — quiet again");
}

void processIncomingCommand(const String& rawCommand) {
    if (rawCommand.length() == 0) return;

    ESP_LOGI(TAG, "Processing incoming command: %s", rawCommand.c_str());

    // Process incoming JSON payload or raw commands
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, rawCommand.c_str());

    if (!error) {
        // 1. Signature updates: {"signatures": [...]}. The signature list is the
        // whole detector now — one always-on mode, so there is no mode command.
        if (doc["signatures"].is<JsonArray>()) {
            updateWatchersSignaturesJson(rawCommand);
            ESP_LOGI(TAG, "Command updated signature rules database");
        }

        // 2. Alarm tuning: {"buzzer": true|false} mutes/unmutes the headless
        // buzzer from the phone (Mode B alarm tuning).
        if (doc["buzzer"].is<bool>()) {
            setBuzzerEnabled(doc["buzzer"].as<bool>());
            ESP_LOGI(TAG, "Buzzer %s by command", doc["buzzer"].as<bool>() ? "enabled" : "muted");
        }

        // 3. Hunt: {"hunt":"AA:BB:CC:DD:EE:FF"} locks the Geiger clicker onto
        // one MAC so you can walk it down; {"hunt":null} clears. This is the
        // only firmware behaviour the app can change — detection itself keeps
        // running for everything else.
        // Clearing is {"hunt":""} rather than null: ArduinoJson reports an
        // absent key and a null value identically, so an empty string is the
        // one form that can't be confused with "no hunt field in this command".
        if (doc["hunt"].is<const char*>()) {
            setHuntTarget(String(doc["hunt"].as<const char*>()));
        }

        // 3b. BLE identity: {"ble_name":"..."} and/or {"rand_mac":bool}. Both
        // are read at boot before NimBLEDevice::init(), so the only honest way
        // to apply them is to store and restart — which is what we do, after a
        // beat so the reply reaches the phone first. The app's reconnect loop
        // picks the device back up on its own.
        if (doc["ble_name"].is<const char*>() || doc["rand_mac"].is<bool>()) {
            String newName = doc["ble_name"].is<const char*>()
                           ? String(doc["ble_name"].as<const char*>())
                           : getBleDeviceName();
            bool newRnd = doc["rand_mac"].is<bool>()
                        ? doc["rand_mac"].as<bool>()
                        : getRandomMacEnabled();
            setBleIdentity(newName, newRnd);
            sendConfigReply();
            requestReboot();
        }

        // 3c. Foxhunt filter: {"scan_all":bool} reports everything the radios
        // hear instead of only signature matches, so you can lock onto and walk
        // down a device that is on no list. Listing only — the buzzer stays
        // gated by CONF_ALERT_MIN either way.
        if (doc["scan_all"].is<bool>()) {
            setScanAll(doc["scan_all"].as<bool>());
        }

        // 3d. What beeps: {"beep_mask":N}, one bit per AlertCategory. Answers
        // with a fresh config reply so the app's checkboxes paint from the
        // device rather than optimistically -- the mask persists, so a board
        // that ran headless comes back with whatever it was last told.
        if (doc["beep_mask"].is<int>()) {
            setBeepMask((uint8_t)(doc["beep_mask"].as<int>() & BEEP_MASK_ALL));
            sendConfigReply();
        }

        // 4. Ring: {"ring":"AA:BB:CC:DD:EE:FF"} makes a suspected tracker
        // announce itself. The MAC is the ONLY parameter — service,
        // characteristic and value are fixed in performRing(). Do not grow this
        // into a general GATT write; that (and the advertisement spoofer next
        // to it) is exactly what was cut for being an offensive primitive.
        if (doc["ring"].is<const char*>()) {
            requestRing(String(doc["ring"].as<const char*>()));
        }

        // 5. Receive-only: {"rx_only":bool}. Stops the device announcing
        // itself. Reply FIRST — turning this on severs the link it arrived on,
        // and an app that never learns the command landed will sit there
        // reconnecting to something that is deliberately gone.
        if (doc["rx_only"].is<bool>()) {
            setRxOnly(doc["rx_only"].as<bool>(), true);
        }
    } else {
        // Raw text fallback parsing (manual serial).
        String rawStr = rawCommand;
        rawStr.trim();

        if (rawStr == "CMD:CFG") {
            // The app asks for this once on connect rather than the firmware
            // pushing it every second: identity is static config, and the 1 Hz
            // payload is the tightest budget on the board.
            sendConfigReply();
        } else if (rawStr == "CMD:SIGS:RESET") {
            // Restore the built-in signature rules, undoing a pushed rule set
            // without the full factory reset (which also wipes mode + lock).
            resetWatchersSignaturesToDefaults();
        } else if (rawStr == "CMD:BLE_SCAN:OFF") {
            pauseBle(true);
            bleScanOn = false;
            sendConfigReply();
        } else if (rawStr == "CMD:BLE_SCAN:ON") {
            pauseBle(false);
            bleScanOn = true;
            sendConfigReply();
        } else if (rawStr == "CMD:WIFI_SCAN:OFF") {
            pauseWifi(true);
            wifiScanOn = false;
            sendConfigReply();
        } else if (rawStr == "CMD:WIFI_SCAN:ON") {
            pauseWifi(false);
            wifiScanOn = true;
            sendConfigReply();
        } else if (rawStr == "CMD:RXONLY:ON") {
            setRxOnly(true, true);
        } else if (rawStr == "CMD:RXONLY:OFF") {
            // The always-available way back in while a USB host is attached.
            // The other two are a short BOOT press and the 5 s factory reset;
            // three independent paths, so lockout is impossible.
            setRxOnly(false, true);
            sendConfigReply();
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

    // Ask for a large MTU. The peer decides, and onMTUChange records what we
    // actually got; this only raises the ceiling.
    NimBLEDevice::setMTU(517);

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

    // A board left in receive-only comes back in receive-only. Everything the
    // operator sets has to survive a power cycle — a detector wired into a car
    // loses power every time the engine stops, and "unplug it and walk away" is
    // the whole foxhunt workflow.
    Preferences prefs;
    prefs.begin(BLE_ID_NVS_NS, true);
    rxOnly = prefs.getBool("rxonly", false);
    prefs.end();

    if (rxOnly) {
        setRxOnlyIndicator(true);
        ESP_LOGI(TAG, "BLE NUS started in receive-only — not advertising.");
    } else {
        startNusAdvertising();
        ESP_LOGI(TAG, "BLE Nordic UART Service started and advertising.");
    }
}

bool isBleSerialConnected() {
    return deviceConnected;
}

void sendBleSerial(const String& data) {
    if (pTxCharacteristic == nullptr) return;

    // Nobody subscribed: skip the whole chunk-and-notify loop. Notifying an
    // unsubscribed characteristic achieves nothing, but the loop still ran --
    // and with no peer there is no negotiated MTU either, so it fragmented a
    // ~3 KB push into ~146 twenty-byte notifications with a yield between each.
    // That was ~300 ms of the telemetry period burned on a link with no
    // listener, which is why the "1 Hz" push measured 0.77 Hz on the bench with
    // only USB attached.
    if (!deviceConnected) return;

    String payload = data + "\n";
    size_t length = payload.length();
    if (length == 0) return;

    // Chunk to the negotiated MTU rather than a fixed 180 bytes. A notification
    // carries MTU-3 bytes of payload; at the common 247-byte MTU that is 244
    // instead of 180, so a ~4 KB telemetry push costs ~17 notifications rather
    // than ~23. Falls back to a conservative 20 (23-3) if the peer never
    // negotiated, which is correct rather than merely lucky.
    size_t maxChunkSize = (negotiatedMtu > 3) ? (size_t)(negotiatedMtu - 3) : 20;
    if (maxChunkSize > 512) maxChunkSize = 512;
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
                // Was 10 ms. At ~32 chunks that was 320 ms of pure sleeping in
                // every 1 s telemetry cycle -- the single largest cost in the
                // loop, and why the "1 Hz" push was measured at 0.77 Hz. 2 ms is
                // still a yield between notifications without dominating the
                // period. ponytail: if notifications start dropping on some
                // phone, raise this before blaming anything else.
                vTaskDelay(pdMS_TO_TICKS(2));
            }
        }
    }
}
