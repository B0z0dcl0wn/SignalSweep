// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "ble_serial.h"
#include "mode_manager.h"
#include "mode_watchers_watch.h"
#include "alert_log.h"
#include "rtc_clock.h"
#include "sd_store.h"
#include "mbedtls/base64.h"
#include "mode_capture.h"
#include <NimBLEDevice.h>
#include <ArduinoJson.h>
#include <esp_log.h>
#include <Preferences.h>
#include <esp_random.h>
#include <esp_system.h>
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
#define BLE_ID_NVS_NS   "sweep-ble"
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
// Lives in the BLE identity namespace rather than the detector's sweep-st,
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

// CMD:SIGS is answered from bleSerialTick(), not from the router — see the
// comment at the command. Written on the NimBLE host task, read on loop().
static volatile bool sigsRequested = false;

// CMD:LOG:READ likewise. One request in flight is enough -- the app pages
// strictly one at a time, waiting for the `done` frame before asking again.
static volatile bool     logReadPending = false;
static volatile uint16_t logReadBoot = 0;
static volatile uint32_t logReadSecs = 0;
static volatile uint32_t logReadSkip = 0;

// CMD:SD:* are answered from bleSerialTick(), never the router: card I/O is tens
// of ms and a listing/file is a bulk reply (see the CMD:SIGS trap). GET and RM
// get their OWN name buffers -- they used to share one, so a GET pipelined
// right after an RM (or a second GET arriving before the first's send loop
// finished) could act on the wrong name, or tear a name mid-strncpy. All of
// it is `volatile`, like logRead*'s args, since it's written on the NimBLE
// host task and read on loop().
static volatile bool     sdLsPending  = false;
static volatile bool     sdGetPending = false;
static volatile bool     sdRmPending  = false;
static volatile char     sdGetName[13] = "";
static volatile uint32_t sdGetOff      = 0;
static volatile char     sdRmName[13]  = "";
#define SD_GET_LINES  8       // SDF: lines per CMD:SD:GET page (the page scales with the line)
#define SD_GET_BATCH  768     // max raw bytes per SDF:/LOG: line (1024 base64 chars); USB always uses it
// A short yield after each bulk base64 line (SDF:, LOG:), so the 1 Hz push
// and the host task get a look in. It is NOT flow control any more: it was
// 25 ms, and that was not enough -- on the bench (S3 + OnePlus, 2026-09-26)
// a 3915 B CMD:SD:GET still lost lines and every done frame. The real cause
// was that notify() dropped a notification silently whenever NimBLE's mbuf
// pool (12 blocks on the S3) was full; sendBleSerial() now waits for room
// (notifyChunk()), and that is the flow control.
#define BULK_LINE_PACE_MS 5

// Which transport the command being routed arrived on. Set by the BLE onWrite
// callback around processIncomingCommand(); USB commands run on loop() with it
// clear. Only used to size bulk lines, so a rare mix-up (a USB command routed
// while a BLE write is in flight) just picks a different line size.
static volatile bool cmdViaBle = false;
static volatile bool sdGetViaBle = false;
static volatile bool logReadViaBle = false;
static size_t bulkLineBytes(bool viaBle);   // defined beside negotiatedMtu

String getBleConfigJson() {
    JsonDocument doc;
    doc["cfg"] = true;
    doc["ble_name"] = getBleDeviceName();
    doc["rand_mac"] = getRandomMacEnabled();
    // Operator state, so a phone connecting to a board that has been running
    // headless learns what it was already doing rather than assuming defaults.
    doc["hunt"] = getHuntTarget();
    doc["scan_all"] = getScanAll();
    doc["attack"] = getAttackDetect();   // pwnagotchi/deauth/karma, off by default
    // Bitmask, not a counter -- "alerts" below is the alert count.
    doc["beep_mask"] = getBeepMask();
    // The mute is operator state and it persists, so the app must paint the
    // buzzer control from here rather than assuming a freshly-connected board
    // is audible. It used to be the one setting the phone owned by guessing.
    doc["buzzer"] = isBuzzerEnabled();
    doc["led"] = getLedMode();   // 0 off, 1 one LED, 2 dim, 3 full
    doc["theme"] = getTheme();   // 0 classic, 1 night, 2 terminal, 3 glacier, 4 party
#if CONFIG_IDF_TARGET_ESP32C5
    doc["band"] = getBand();     // 0 both, 1 2.4 GHz, 2 5 GHz (C5 only)
#endif
    doc["rx_only"] = rxOnly;
    doc["ble_scan"] = bleScanOn;
    doc["wifi_scan"] = wifiScanOn;
    doc["alerts"] = getAlertCount();
    // Alert log (alert_log.h). log_boot/log_secs are the board's current
    // ordering key: the app stores them as a "from here" bookmark when you
    // start a session, and passes them back to CMD:LOG:READ. log_n is what is
    // held, for the fill gauge -- ALERT_LOG_MAX_RECS is the ceiling and
    // app/selftest.js pins the two together.
    doc["log"] = getAlertLogEnabled();
    doc["log_n"] = alertLogCount();
    doc["log_boot"] = alertLogBoot();
    doc["log_secs"] = alertLogSecs();
    // Seconds since boot, asked once on connect; the app counts on from there
    // rather than have it ride the 1 Hz push.
    doc["uptime"] = millis() / 1000;
    // Why the board last booted (esp_reset_reason(): 4 panic, 5-7 watchdog,
    // 9 brownout). Nothing else survives a crash with no host logging.
    doc["reset"] = (int)esp_reset_reason();
    // Optional DS3231 (rtc_clock.h): 0 absent, 1 ok, 2 fitted but lost power.
    // epoch is the board's UTC now, 0 until a host or the RTC has set it.
    doc["rtc"] = rtcState();
    doc["epoch"] = rtcNow();
    // Optional microSD (sd_store.h): 0 none, 1 ok, 2 error, 3 full; free in MB.
    doc["sd"] = sdState();
    doc["sd_free"] = sdFreeMB();
    String out;
    serializeJson(doc, out);
    return out;
}

// Reply on both transports. sendBleSerial() deliberately returns early with no
// client subscribed, so a BLE-only reply is invisible over USB — which makes the
// identity commands untestable from a serial console, the one place you'd reach
// for when the BLE name is what you're trying to fix.
// Replies go to BOTH transports. sendBleSerial() returns early when no BLE
// client is subscribed, so a reply sent through it alone is simply lost on a
// board reached over the USB cable -- which is one of the three transports the
// app supports, and the one used on the bench.
static void sendReply(const String& payload) {
    sendBleSerial(payload);
    sendUsbLine(payload);
}

static void sendConfigReply() {
    sendReply(getBleConfigJson());
}

// ---------------------------------------------------------------------------
// Alert log readback.
//
// Bulk, so it follows the CAP: precedent: a JSON header frame, then base64
// payload lines, then a done frame. Unlike capture this does NOT pause the
// detector and is small enough for BLE -- a walk or a drive is tens to a few
// hundred records (16 B each), not the megabytes a packet capture produces.
//
// Capped per request; the app pages with <skip>. The scratch buffer is a
// plain heap allocation, deliberately not ps_malloc: the C5 has no PSRAM, and
// 8 KB is small enough to be uncontroversial on either board.
// ---------------------------------------------------------------------------
#define LOG_READ_MAX   512    // records per request, 8 KB
#define LOG_READ_BATCH 48     // records per base64 line (768 B -> 1024 chars)

// ---------------------------------------------------------------------------
// Optional microSD (sd_store.h) readback. Same shape as the alert log above:
// a JSON header, then base64 payload lines, then a done frame. Deferred to
// bleSerialTick() -- see the CMD:SD:* flags above.
// ---------------------------------------------------------------------------
static void sendSdList() {
    // Re-probe only when not already mounted. An unconditional re-probe would
    // tear down an in-progress capture stream (sdStreamOpen()/sdStreamWrite())
    // out from under it -- SD.end()/SD.begin() while a File handle is open. A
    // card inserted after boot is still SD_NONE (or SD_ERROR) until the next
    // probe, so this still adopts it; it just never re-probes a card that's
    // already working.
    if (sdState() != SD_OK) sdProbe();
    const bool wasOk = sdState() == SD_OK;
    static SdEntry files[128];
    size_t total = 0;
    size_t n = sdList(files, 128, &total);
    // The card was OK going in and the listing found it gone (sdList() calls
    // fail()): probe once, so a card that was pulled reports SD_NONE and one
    // that was swapped and answers is listed, rather than an empty "OK".
    if (wasOk && sdState() != SD_OK && sdProbe()) n = sdList(files, 128, &total);
    JsonDocument doc;
    JsonObject o = doc["sdls"].to<JsonObject>();
    o["state"] = sdState();
    o["free"] = sdFreeMB();
    o["total"] = total;
    JsonArray a = o["files"].to<JsonArray>();
    for (size_t i = 0; i < n; i++) {
        JsonObject f = a.add<JsonObject>();
        f["n"] = files[i].name;
        f["s"] = files[i].size;
    }
    String out;
    serializeJson(doc, out);
    sendReply(out);
}

static void sendSdFile(const char* name, uint32_t off, bool viaBle) {
    // A USB (not card) capture owns the serial port: its CAP: stream is the
    // whole of the USB traffic, and a download interleaved with it would
    // corrupt both. Say busy; the app can ask again when it ends.
    if (isCapturingToUsb()) { sendReply("{\"sdget\":{\"err\":\"busy\"}}"); return; }
    // Over BLE each SDF: line must fit ONE notification (bulkLineBytes()), so
    // a lost notification loses a whole line cleanly, never half of one.
    const size_t batch = bulkLineBytes(viaBle);
    uint8_t* buf = (uint8_t*)malloc(SD_GET_BATCH);
    uint8_t* b64 = (uint8_t*)malloc((SD_GET_BATCH * 4) / 3 + 8);
    if (!buf || !b64) { free(buf); free(b64); sendReply("{\"sdget\":{\"err\":\"mem\"}}"); return; }
    // The capture being written right now is not readable yet (sdRead()
    // refuses it); say so, rather than "no such file" for a file in the list.
    if (sdIsOpen(name)) { free(buf); free(b64); sendReply("{\"sdget\":{\"err\":\"busy\"}}"); return; }
    uint32_t size = 0;
    int32_t got = sdRead(name, off, buf, batch, &size);
    if (got < 0) { free(buf); free(b64); sendReply("{\"sdget\":{\"err\":\"no such file\"}}"); return; }
    {
        JsonDocument h;
        JsonObject o = h["sdget"].to<JsonObject>();
        o["n"] = name; o["size"] = size; o["off"] = off;
        String out; serializeJson(h, out); sendReply(out);
    }
    uint32_t pos = off, sent = 0;
    bool readFailed = false;
    while (got > 0) {
        size_t olen = 0;
        if (mbedtls_base64_encode(b64, (SD_GET_BATCH * 4) / 3 + 8, &olen, buf, (size_t)got) != 0) break;
        String line = "SDF:";
        line.concat((const char*)b64, olen);
        sendReply(line);
        vTaskDelay(pdMS_TO_TICKS(BULK_LINE_PACE_MS));
        pos += got; sent += got;
        if (sent >= SD_GET_LINES * batch || pos >= size) break;
        got = sdRead(name, pos, buf, batch, &size);
        // pos < size here (the break above already caught pos >= size), so a
        // non-positive read is a genuine failure, not real EOF -- the file
        // shrank, the card dropped out, whatever. Never tell a client "more"
        // is coming when nothing more was actually read.
        if (got <= 0) readFailed = true;
    }
    free(buf); free(b64);
    if (readFailed) {
        char err[80];
        snprintf(err, sizeof(err), "{\"sdget\":{\"err\":\"read failed\",\"next\":%u}}", (unsigned)pos);
        sendReply(err);
        return;
    }
    // "off" echoes the request, so the app can tell this page's done frame
    // from a stale one belonging to a request it has already replaced.
    char done[112];
    snprintf(done, sizeof(done), "{\"sdget\":{\"done\":true,\"off\":%u,\"next\":%u,\"more\":%s}}",
             (unsigned)off, (unsigned)pos, pos < size ? "true" : "false");
    sendReply(done);
}

static void sendAlertLog(uint16_t fromBoot, uint32_t fromSecs, size_t skip, bool viaBle) {
    // Whole records per line (the app decodes each LOG: line on its own and
    // walks it 16 bytes at a time), sized so a BLE line is one notification.
    size_t perLine = bulkLineBytes(viaBle) / ALERT_LOG_REC_SIZE;
    if (perLine > LOG_READ_BATCH) perLine = LOG_READ_BATCH;
    uint8_t* buf = (uint8_t*)malloc(LOG_READ_MAX * ALERT_LOG_REC_SIZE);
    if (buf == NULL) {
        sendReply("{\"logrd\":{\"err\":\"mem\"}}");
        return;
    }
    bool more = false;
    size_t n = alertLogRead(fromBoot, fromSecs, skip, buf, LOG_READ_MAX, &more);

    // The name table only on the first page -- it is the same every page and
    // the app has it after one.
    {
        JsonDocument hdr;
        JsonObject o = hdr["logrd"].to<JsonObject>();
        o["n"] = (uint32_t)n;
        o["skip"] = (uint32_t)skip;
        o["more"] = more;
        if (skip == 0) o["names"] = alertLogNames();

        // One anchor per boot present in this page (records are key-ordered,
        // so each boot is a contiguous run). Every page, not just the first:
        // a later page can start a boot the first one never reached.
        JsonObject ep = o["epochs"].to<JsonObject>();
        bool any = false;
        uint16_t lastBoot = 0;
        for (size_t i = 0; i < n; i++) {
            const uint8_t* r = buf + i * ALERT_LOG_REC_SIZE;
            uint16_t b = (uint16_t)(r[0] | (r[1] << 8));
            if (any && b == lastBoot) continue;
            any = true;
            lastBoot = b;
            uint32_t e = alertLogEpochFor(b);
            if (e) ep[String(b)] = e;
        }
        String out;
        serializeJson(hdr, out);
        sendReply(out);
    }

    // Heap, not stack. This is called from bleSerialTick() now, but it used to
    // run on the NimBLE host callback (onWrite), where a ~1 KB local array here
    // is exactly what overflowed the canary -- keep it malloc'd so moving the
    // call site again cannot bring that back.
    const size_t b64cap = ((LOG_READ_BATCH * ALERT_LOG_REC_SIZE) * 4) / 3 + 8;
    uint8_t* b64 = (uint8_t*)malloc(b64cap);
    if (b64 == NULL) { free(buf); sendReply("{\"logrd\":{\"done\":true}}"); return; }
    for (size_t off = 0; off < n; off += perLine) {
        size_t take = (n - off < perLine) ? (n - off) : perLine;
        size_t olen = 0;
        if (mbedtls_base64_encode(b64, b64cap, &olen,
                                  buf + off * ALERT_LOG_REC_SIZE,
                                  take * ALERT_LOG_REC_SIZE) != 0) break;
        String line = "LOG:";
        line.concat((const char*)b64, olen);
        sendReply(line);
        // Let the notify queue drain between lines -- see BULK_LINE_PACE_MS.
        vTaskDelay(pdMS_TO_TICKS(BULK_LINE_PACE_MS));
    }
    free(b64);
    free(buf);
    sendReply("{\"logrd\":{\"done\":true}}");
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

// Raw bytes per bulk base64 line (SDF:, LOG:). Over BLE the whole line --
// 4 prefix + base64 + "\n" -- fits ONE notification (MTU-3 bytes), so a
// notification the stack gives up on loses one whole line, which the app's
// page check catches, rather than tearing it. Clamped to [48, 768]: below 48
// (a peer stuck at MTU 23) a line spans notifications again, which still
// works with the backpressure in notifyChunk(). USB takes the full 768.
static size_t bulkLineBytes(bool viaBle) {
    if (!viaBle) return SD_GET_BATCH;
    size_t n = (negotiatedMtu > 8) ? ((size_t)(negotiatedMtu - 3 - 5) / 4) * 3 : 0;
    if (n < 48) n = 48;
    if (n > SD_GET_BATCH) n = SD_GET_BATCH;
    return n;
}

// One writer at a time. A push is reassembled by the app on newlines, so if the
// detector's 1 Hz push interleaves its notifications with a multi-chunk reply
// from loop() (CMD:SIGS is ~20 chunks), the app sees two half-JSONs and throws
// both away. Created lazily on first use; a null mutex just means "send".
static SemaphoreHandle_t txMutex = NULL;

// Same rule on the USB mirror. Serial.println() of a 1 KB line is not atomic
// across tasks: the detector's 1 Hz push landed in the middle of an SDF: line
// on the bench, and a USB download came back 72 bytes long with the push's
// letters decoded as file data. Created in bleSerialInit() (before the
// detector task exists), lazily as a fallback.
static SemaphoreHandle_t usbTxMutex = NULL;

void sendUsbLine(const String& line) {
    if (!Serial) return;   // skip the USB mirror when no host is attached
    if (usbTxMutex == NULL) usbTxMutex = xSemaphoreCreateMutex();
    if (usbTxMutex) xSemaphoreTake(usbTxMutex, portMAX_DELAY);
    Serial.println(line);
    if (usbTxMutex) xSemaphoreGive(usbTxMutex);
}

void sendUsbLine(const char* prefix, const uint8_t* data, size_t len) {
    if (!Serial) return;
    if (usbTxMutex == NULL) usbTxMutex = xSemaphoreCreateMutex();
    if (usbTxMutex) xSemaphoreTake(usbTxMutex, portMAX_DELAY);
    Serial.print(prefix);
    Serial.write(data, len);
    Serial.print('\n');
    if (usbTxMutex) xSemaphoreGive(usbTxMutex);
}

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
#if CONFIG_IDF_TARGET_ESP32C5
    // NimBLE 2.x does not put the device name in the advertisement for you, and
    // setName() only lands in the scan response when the scan response is
    // enabled FIRST (flags + the 128-bit UUID already use 21 of 31 bytes).
    // Configured once: addServiceUUID() on every re-advertise would append
    // duplicates. A name change reboots the board, so once is enough.
    static bool advConfigured = false;
    if (!advConfigured) {
        pAdvertising->addServiceUUID(SERVICE_UUID);
        pAdvertising->enableScanResponse(true);
        pAdvertising->setName(getBleDeviceName().c_str());
        advConfigured = true;
    }
#else
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);   // name rides in the scan response
#endif
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
#if CONFIG_IDF_TARGET_ESP32C5
    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) override {
#else
    void onConnect(NimBLEServer* pServer) override {
#endif
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

#if CONFIG_IDF_TARGET_ESP32C5
    void onMTUChange(uint16_t MTU, NimBLEConnInfo& connInfo) override {
#else
    void onMTUChange(uint16_t MTU, ble_gap_conn_desc* desc) override {
#endif
        negotiatedMtu = MTU;
        ESP_LOGI(TAG, "Peer MTU negotiated: %u", (unsigned)MTU);
    }

#if CONFIG_IDF_TARGET_ESP32C5
    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override {
#else
    void onDisconnect(NimBLEServer* pServer) override {
#endif
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
    // Answer a deferred CMD:SIGS from loop(), off the NimBLE host task.
    if (sigsRequested) {
        sigsRequested = false;
        sendReply(getWatchersSignaturesJson());
    }

    if (logReadPending) {
        logReadPending = false;
        sendAlertLog(logReadBoot, logReadSecs, (size_t)logReadSkip, logReadViaBle);
    }

    if (sdLsPending) { sdLsPending = false; sendSdList(); }
    if (sdGetPending) {
        sdGetPending = false;
        // Copy the name/offset into locals before calling: sendSdFile()'s
        // send loop runs for a while (up to SD_GET_LINES lines, one BULK_LINE_PACE_MS pause per
        // line), and reading the volatile globals again partway through
        // would let a later CMD:SD:GET on this same tick's queue -- or a
        // torn write from the router mid-copy -- switch files under it.
        char nm[13];
        strncpy(nm, (const char*)sdGetName, sizeof(nm) - 1);
        nm[sizeof(nm) - 1] = 0;
        uint32_t off = sdGetOff;
        sendSdFile(nm, off, sdGetViaBle);
    }
    if (sdRmPending) {
        sdRmPending = false;
        char nm[13];
        strncpy(nm, (const char*)sdRmName, sizeof(nm) - 1);
        nm[sizeof(nm) - 1] = 0;
        // Failures answer on their own key, one small line; success answers
        // with the fresh listing, which is what the app repaints from.
        if (sdIsOpen(nm))          sendReply("{\"sdrm\":{\"err\":\"busy\"}}");
        else if (sdState() == SD_OK && !sdExists(nm)) sendReply("{\"sdrm\":{\"err\":\"no such file\"}}");
        else if (!sdRemove(nm))    sendReply("{\"sdrm\":{\"err\":\"card error\"}}");
        else                       sendSdList();
    }

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
            // Answer, so the app's button paints from the device rather than
            // optimistically -- same contract as beep_mask and the radios.
            sendConfigReply();
        }

        // 2b. Lights: {"led":0..3} = off / one LED / dim / full. Persisted,
        // and answered so the app paints from the device, like the buzzer.
        if (doc["led"].is<int>()) {
            setLedMode((uint8_t)constrain(doc["led"].as<int>(), 0, (int)LED_FULL));
            sendConfigReply();
        }

        // 2c. Theme: {"theme":0..4}, the bar's colour + the buzzer's pitch.
        // Persisted, and answered so the app paints from the device.
        if (doc["theme"].is<int>()) {
            setTheme((uint8_t)constrain(doc["theme"].as<int>(), 0, (int)THEME_PARTY));
            sendConfigReply();
        }

        // 2d. Easter egg: {"egg":0..5}, the bar as a flashlight / light show.
        // Deliberately NOT persisted, NOT in CMD:CFG and NOT in the push, so
        // no reply here either: it is transient by design and the firmware's
        // own timeout, not the app, is what guarantees a board never gets
        // stranded at full white. The app is the authority on this one.
        if (doc["egg"].is<int>()) {
            setEggScene((uint8_t)constrain(doc["egg"].as<int>(), 0, EGG_COUNT - 1));
        }

#if CONFIG_IDF_TARGET_ESP32C5
        if (doc["band"].is<int>()) {
            setBand((uint8_t)constrain(doc["band"].as<int>(), 0, 2));
            sendConfigReply();
        }
#endif

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

        // 3c'. Attack-gear detection: {"attack":bool}. Off by default; gates the
        // pwnagotchi/deauth/karma detectors. Config reply so the app paints from
        // the device, like the beep mask.
        if (doc["attack"].is<bool>()) {
            setAttackDetect(doc["attack"].as<bool>());
            sendConfigReply();
        }

        // 3c''. Alert logging: {"log":bool}. Off by default, persisted. Writes
        // every sounded alert to the board's flash so a headless drive can be
        // read back later -- see alert_log.h. Config reply so the app paints
        // from the device.
        if (doc["log"].is<bool>()) {
            setAlertLogEnabled(doc["log"].as<bool>());
            sendConfigReply();
        }

        // 3c'''. Host clock: {"time":<unix seconds, UTC>}, sent by the app on
        // every connect. The host is always right, except for a plainly unset
        // clock (rtcSetEpoch rejects it). Small on purpose: this is the NimBLE
        // host task. The log anchor it triggers is written later, from the tick.
        if (doc["time"].is<uint32_t>()) {
            rtcSetEpoch(doc["time"].as<uint32_t>());
            sendConfigReply();
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
        } else if (rawStr == "CMD:SIGS") {
            // Read back the rules the board is actually carrying. Without this
            // the editor opened blank against an unknown device and saving
            // replaced a rule set nobody had seen. On demand only, never on
            // connect: the reply is multi-KB and the 1 Hz push is the tight
            // budget. sendBleSerial() already chunks it to the MTU.
            //
            // Deferred to bleSerialTick() instead of answered here, because
            // this router runs on the NimBLE host task (the onWrite callback)
            // and a multi-KB reply is ~20+ notifications with a vTaskDelay
            // between each. The host task cannot drain its own tx queue while
            // it is blocked inside our callback, so the mbuf pool runs dry and
            // the reply is silently lost — the Signatures page loaded over USB
            // (where commands run on loop()) and stayed blank over BLE.
            // Building the JSON here also put a JsonDocument plus a multi-KB
            // String on that small stack.
            sigsRequested = true;
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
        } else if (rawStr == "CMD:ATTACK:ON") {
            setAttackDetect(true);
            sendConfigReply();
        } else if (rawStr == "CMD:ATTACK:OFF") {
            setAttackDetect(false);
            sendConfigReply();
        } else if (rawStr == "CMD:RXONLY:ON") {
            setRxOnly(true, true);
        } else if (rawStr == "CMD:RXONLY:OFF") {
            // The always-available way back in while a USB host is attached.
            // The other two are a short BOOT press and the 5 s factory reset;
            // three independent paths, so lockout is impossible.
            setRxOnly(false, true);
            sendConfigReply();
        } else if (rawStr.startsWith("CMD:CAP:START:")) {
            // CMD:CAP:START:<secs>[:SD]. USB streams the raw capture; ":SD" writes
            // it to the card instead (the only way over BLE). Deferred to loop().
            String rest = rawStr.substring(14);   // 14 = len("CMD:CAP:START:")
            bool toSd = rest.endsWith(":SD");
            requestCapture((uint32_t)rest.toInt(), toSd);
        } else if (rawStr == "CMD:CAP:STOP") {
            stopCapture();
        } else if (rawStr == "CMD:LOG:ON") {
            setAlertLogEnabled(true);
            sendConfigReply();
        } else if (rawStr == "CMD:LOG:OFF") {
            setAlertLogEnabled(false);
            sendConfigReply();
        } else if (rawStr == "CMD:LOG:CLEAR") {
            alertLogClear();
            sendConfigReply();
        } else if (rawStr == "CMD:LOG:STAT") {
            sendConfigReply();   // log_n / log_boot / log_secs all ride CMD:CFG
        } else if (rawStr.startsWith("CMD:LOG:READ:")) {
            // CMD:LOG:READ:<boot>:<secs>:<skip> -- everything at or after that
            // key, oldest first, skipping the first <skip> matches. Exact
            // paging: several alerts can share one second, so a timestamp-only
            // cursor would make the app de-duplicate.
            String args = rawStr.substring(13);   // 13 = len("CMD:LOG:READ:")
            int c1 = args.indexOf(':');
            int c2 = (c1 < 0) ? -1 : args.indexOf(':', c1 + 1);
            if (c1 > 0 && c2 > c1) {
                uint16_t fb = (uint16_t)args.substring(0, c1).toInt();
                uint32_t fs = (uint32_t)args.substring(c1 + 1, c2).toInt();
                size_t skip = (size_t)args.substring(c2 + 1).toInt();
                // Deferred to bleSerialTick() for the same reason as CMD:SIGS:
                // this router runs on the NimBLE host task, which cannot drain
                // its own notify queue while blocked in our callback, and a
                // page is a header plus up to 11 base64 lines. It also does
                // LittleFS reads and two mallocs, none of which belong on that
                // task. Over USB it ran on loop() and looked fine.
                logReadBoot = fb;
                logReadSecs = fs;
                logReadSkip = skip;
                logReadViaBle = cmdViaBle;
                logReadPending = true;
            }
        } else if (rawStr == "CMD:SD:LS") {
            sdLsPending = true;
        } else if (rawStr.startsWith("CMD:SD:GET:")) {
            // CMD:SD:GET:<name>:<offset>. Validated here; the read is deferred.
            String rest = rawStr.substring(11);
            int c = rest.indexOf(':');
            String nm = c > 0 ? rest.substring(0, c) : rest;
            if (nm.length() <= 12 && sdValidName(nm.c_str())) {
                strncpy((char*)sdGetName, nm.c_str(), sizeof(sdGetName) - 1);
                sdGetOff = c > 0 ? (uint32_t)rest.substring(c + 1).toInt() : 0;
                sdGetViaBle = cmdViaBle;
                sdGetPending = true;
            } else {
                sendReply("{\"sdget\":{\"err\":\"bad name\"}}");
            }
        } else if (rawStr.startsWith("CMD:SD:RM:")) {
            String nm = rawStr.substring(10);
            if (nm.length() <= 12 && sdValidName(nm.c_str())) {
                strncpy((char*)sdRmName, nm.c_str(), sizeof(sdRmName) - 1);
                sdRmPending = true;
            } else {
                sendReply("{\"sdrm\":{\"err\":\"bad name\"}}");
            }
        }
    }
}

class RxCallbacks : public NimBLECharacteristicCallbacks {
#if CONFIG_IDF_TARGET_ESP32C5
    void onWrite(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo& connInfo) override {
#else
    void onWrite(NimBLECharacteristic *pCharacteristic) override {
#endif
        std::string rxValue = pCharacteristic->getValue();
        if (rxValue.length() > 0) {
            cmdViaBle = true;
            processIncomingCommand(String(rxValue.c_str()));
            cmdViaBle = false;
        }
    }
};

static ServerCallbacks serverCallbacks;
static RxCallbacks rxCallbacks;

void bleSerialInit() {
    ESP_LOGI(TAG, "Initializing BLE Serial Service (Nordic UART Service)...");
    if (usbTxMutex == NULL) usbTxMutex = xSemaphoreCreateMutex();

    pServer = NimBLEDevice::createServer();
#if CONFIG_IDF_TARGET_ESP32C5
    // NimBLE 2.x deletes a callbacks object it is handed unless told not to;
    // serverCallbacks is static, so deleting it would be a heap corruption.
    pServer->setCallbacks(&serverCallbacks, false);
#else
    pServer->setCallbacks(&serverCallbacks);
#endif

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

// One notification, with backpressure. THE root cause of BLE message loss:
// NimBLECharacteristic::notify() (1.4.3 and 2.5.1 alike) builds the mbuf with
// ble_hs_mbuf_from_flat() and calls ble_gattc_notify_custom(), and the S3's
// 1.4 ignores both failures -- a NULL mbuf even falls through to "read the
// attribute value", which allocates from the same empty pool. The pool is 12
// blocks, and a notification the controller cannot take yet sits in the
// connection's tx queue holding its block, so a bulk reply plus the 1 Hz push
// exhausted it and the rest of the burst vanished with no error anywhere.
// Here the result is visible: out of mbufs (NULL, or BLE_HS_ENOMEM from the
// ATT/L2CAP header prepends) or BLE_HS_EBUSY means "no room yet", so wait and
// resend the SAME chunk; anything else (not connected, ...) is final.
// ble_gattc_notify_custom() consumes the mbuf on every path, success or not.
//
// Bounded, because this can run on the NimBLE host task (a router reply), and
// that task is the one that frees the pool when the controller reports
// packets sent -- a wait there cannot be satisfied, so it must give up. No
// locals beyond a few words: see the host-task stack trap.
#define NOTIFY_RETRY_MS  5
#define NOTIFY_GIVEUP_MS 300
static bool notifyChunk(uint16_t conn, uint16_t attr, const uint8_t* p, size_t n) {
    uint32_t start = millis();
    for (;;) {
        os_mbuf* om = ble_hs_mbuf_from_flat(p, n);
        int rc = om ? ble_gattc_notify_custom(conn, attr, om) : BLE_HS_ENOMEM;
        if (rc == 0) return true;
        if (rc != BLE_HS_ENOMEM && rc != BLE_HS_EBUSY) return false;
        if (millis() - start >= NOTIFY_GIVEUP_MS) return false;
        vTaskDelay(pdMS_TO_TICKS(NOTIFY_RETRY_MS));
    }
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

#if !CONFIG_IDF_TARGET_ESP32C5
    // NimBLE-Arduino 1.4's notify() skipped a peer that had not subscribed;
    // 2.x keeps no subscriber list (its notify() sends to every peer), so the
    // C5 keeps sending as it always did.
    if (pTxCharacteristic->getSubscribedCount() == 0) return;
#endif
    const uint16_t attr = pTxCharacteristic->getHandle();
    const std::vector<uint16_t> peers = pServer->getPeerDevices();
    if (peers.empty()) return;

    if (txMutex == NULL) txMutex = xSemaphoreCreateMutex();
    if (txMutex) xSemaphoreTake(txMutex, portMAX_DELAY);

    // Chunk to the negotiated MTU rather than a fixed 180 bytes. A notification
    // carries MTU-3 bytes of payload; at the common 247-byte MTU that is 244
    // instead of 180, so a ~4 KB telemetry push costs ~17 notifications rather
    // than ~23. Falls back to a conservative 20 (23-3) if the peer never
    // negotiated, which is correct rather than merely lucky.
    size_t maxChunkSize = (negotiatedMtu > 3) ? (size_t)(negotiatedMtu - 3) : 20;
    if (maxChunkSize > 512) maxChunkSize = 512;
    size_t offset = 0;
    bool ok = true;
    while (ok && offset < length) {
        size_t chunkSize = (length - offset > maxChunkSize) ? maxChunkSize : (length - offset);
        // A chunk the stack gives up on ends THIS message: the app reassembles
        // on newlines, so the rest would only be glued to a torn head.
        for (uint16_t conn : peers) {
            if (!notifyChunk(conn, attr, (const uint8_t*)payload.c_str() + offset, chunkSize)) ok = false;
        }
        offset += chunkSize;
        // Was 10 ms, then 2 ms "so notifications don't drop" -- they dropped
        // anyway, because the loss was notify() ignoring a full mbuf pool, not
        // timing. notifyChunk() waits for room now; this is just a yield.
        if (ok && offset < length) vTaskDelay(pdMS_TO_TICKS(2));
    }

    if (txMutex) xSemaphoreGive(txMutex);
}
