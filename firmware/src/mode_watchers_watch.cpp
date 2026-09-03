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
#include <algorithm>
#include "hardware_manager.h"
#include "capabilities.h"
#include "mode_manager.h"
extern "C" {
#include "opendroneid.h"
#include "odid_wifi.h"
}

static const char *TAG = "WatchersWatch";
static const char *SIG_FILE_PATH = "/data/signatures.json";

// Bump whenever the DEFAULT rule set changes meaningfully. The file lives on
// LittleFS and survives a firmware flash, so without this an already-deployed
// device keeps its old rules for ever — which is how the purged Espressif /
// unassigned / locally-administered OUIs would have quietly stayed in service
// on every board that had already booted once.
//   v2: removed a4:cf:12 + 3c:71:bf (Espressif, i.e. this very board's vendor
//       block), cc:cc:cc (unassigned), 82:6b:f2 (locally-administered).
//   v3: removed mfg_id 0x01 ("Flock XUNTONG"). 0x0001 is Nokia's assigned
//       Bluetooth Company ID; on the bench it matched Govee bulbs.
//   v4: added Tracker category (Tile / Samsung SmartTag service UUIDs). AirTag
//       "offline finding" is matched in code, not here (needs a payload type
//       byte the rule schema can't express). Feeds the Tracker buzzer word.
//   v5: removed the Raven rules — device names "raven"/"penguin" and service
//       UUIDs 3100/3200/3300/3400/3500. Both scored at or above CONF_ALERT_MIN
//       (W_NAME/W_UUID = 70), so a single one could fire the buzzer on its own,
//       and both are far too generic to carry that: "raven" and "penguin" are
//       ordinary product words matched as substrings, and a four-hex-digit UUID
//       is substring-matched against every UUID a device advertises. Same
//       failure shape as the mfg 0x01 rule that labelled Govee bulbs "Flock".
#define SIG_SCHEMA_VERSION 5

static SemaphoreHandle_t watchersMutex = NULL;
static bool watchersRunning = false;
static std::vector<WatcherSignature> loadedSignatures;
static std::vector<WatcherTargetInfo> trackedTargets;
static TaskHandle_t watchersTaskHandle = NULL;

// Hunt: the one opt-in behaviour change on an otherwise always-on detector.
// While a MAC is hunted, its RSSI drives the Geiger clicker so you can walk a
// planted tracker down by ear. Everything else keeps detecting and beeping
// normally — this is a single variable, not a mode: no queue, no NVS, no
// selector, none of the state machine the last pass deleted.
static String huntMac = "";
// Ring is requested from the BLE write callback but performed on the 1 Hz task:
// a GATT connect must not run on the NimBLE callback stack, and it has to stop
// the scan first.
static String pendingRingMac = "";
/**
 * @brief Ensure /data/signatures.json exists on LittleFS, creating default rules if missing
 */
static void ensureSignaturesFileExists() {
    // Regenerate a file written by an older default rule set.
    if (LittleFS.exists(SIG_FILE_PATH)) {
        int fileVersion = 0;
        File existing = LittleFS.open(SIG_FILE_PATH, "r");
        if (existing) {
            JsonDocument probe;
            if (!deserializeJson(probe, existing)) {
                fileVersion = probe["version"] | 0;
            }
            existing.close();
        }
        if (fileVersion < SIG_SCHEMA_VERSION) {
            ESP_LOGW(TAG, "signatures.json is v%d, defaults are v%d — regenerating.",
                     fileVersion, SIG_SCHEMA_VERSION);
            LittleFS.remove(SIG_FILE_PATH);
        }
    }

    if (!LittleFS.exists(SIG_FILE_PATH)) {
        ESP_LOGI(TAG, "%s not found. Creating default signatures file...", SIG_FILE_PATH);
        if (!LittleFS.exists("/data")) {
            LittleFS.mkdir("/data");
        }
        File file = LittleFS.open(SIG_FILE_PATH, "w");
        if (file) {
            JsonDocument doc;
            doc["version"] = SIG_SCHEMA_VERSION;
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

            // GoFlockYourself extended OUIs. Four entries from the original
            // crowd-sourced list are deliberately absent because they cannot
            // mean "Flock" and only generate false positives:
            //   a4:cf:12, 3c:71:bf  Espressif — this board's own vendor block,
            //                       so every ESP32 in range matched.
            //   cc:cc:cc            not an assigned OUI at all.
            //   82:6b:f2            locally-administered bit set (0x02) — that
            //                       is a randomized-MAC prefix, i.e. phones.
            // loadWatchersSignatures() also rejects locally-administered
            // prefixes at load time so a pushed rule set can't reintroduce them.
            const char* flockOuis[] = {
                "b4:1e:52", "70:c9:4e", "3c:91:80", "d8:f3:bc", "80:30:49", "b8:35:32",
                "14:5a:fc", "74:4c:a1", "08:3a:88", "9c:2f:9d", "c0:35:32", "94:08:53",
                "e4:aa:ea", "f4:6a:dd", "f8:a2:d6", "24:b2:b9", "00:f4:8d", "d0:39:57",
                "e8:d0:fc", "e0:4f:43", "b8:1e:a4", "70:08:94", "58:8e:81", "ec:1b:bd",
                "58:00:e3", "90:35:ea", "5c:93:a2", "64:6e:69", "48:27:ea",
                "04:0d:84", "1c:34:f1", "38:5b:44", "94:34:69",
                "b4:e3:f9", "f0:82:c0", "e0:0a:f6"
            };
            for (const char* oui : flockOuis) {
                addRule("Flock Safety MAC", "Flock Safety", oui, "", "", "");
            }

            // SoundThinking / ShotSpotter
            addRule("SoundThinking", "SoundThinking", "d4:11:d6", "", "", "");

            // NOTE: the Raven service-UUID rules (3100/3200/3300/3400/3500)
            // were removed at v5. service_uuid is substring-matched against
            // every UUID a device advertises, so a four-hex-digit needle hits
            // constantly — and at W_UUID (70) a single hit is enough to beep.
            // A UUID rule has to be specific enough to stand alone, because
            // that is exactly what CONF_ALERT_MIN lets it do.

            // Device Name Keywords. "raven" and "penguin" were dropped at v5:
            // ordinary words, matched as substrings, scoring W_NAME (70) — i.e.
            // self-sufficient to sound the alarm on someone's bluetooth speaker.
            const char* bleNames[] = {"flock", "pigvision", "fs_"};
            for (const char* name : bleNames) {
                addRule("Flock BLE Name", "Flock Safety", "", "", name, "");
            }
            
            // NOTE: a rule matching manufacturer ID 0x01 was removed here.
            // Bluetooth Company ID 0x0001 is Nokia's, not Flock's, and once the
            // signature file actually started loading it immediately labelled
            // Govee smart bulbs as "Flock Safety / Likely" on the bench. Same
            // class of junk as the Espressif OUIs above.

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

            // Trackers (planted-on-you category). Keyed on service UUID, which
            // the matcher already handles. AirTag is matched in code (its Find
            // My advert carries no service UUID — just Apple mfr data + a type
            // byte the rule schema can't express). Headless can only say "a
            // tracker is near", not "it's following you" — that needed the
            // geospatial history removed for opsec. Still worth the beep.
            addRule("Tile Tracker", "Tracker", "", "", "", "feed");
            addRule("Tile Tracker", "Tracker", "", "", "", "feec");
            addRule("Samsung SmartTag", "Tracker", "", "", "", "fd5a");

            serializeJsonPretty(doc, file);
            file.close();
            ESP_LOGI(TAG, "Default signatures created successfully.");
        } else {
            ESP_LOGE(TAG, "Failed to open %s for writing!", SIG_FILE_PATH);
        }
    }
}

/**
 * @brief Confidence weights per signal type. An OUI prefix is weak (shared
 * across a vendor's whole catalogue and easily randomized); a matching mfg ID
 * is medium; a device-name substring or service UUID is strong. WiFi vendor-IE
 * and SSID weights live in the promiscuous callback.
 * ponytail: tune these against field false-positive rates.
 */
#define W_OUI    30
#define W_MFG    45
#define W_NAME   70
#define W_UUID   70
#define W_WIFI_OUI 30
// ponytail: Lite-On vendor IE (50:6F:9A) is only a weak hint — 50:6F:9A is
// Lite-On Technology's general OUI, present in many consumer WiFi chips, not
// Flock-specific. Bench testing flagged 3 random nearby devices as "Confirmed"
// when this was 80. Keep it weak; real confidence needs the SSID or corroboration.
#define W_WIFI_IE  30
#define W_WIFI_SSID 80
#define W_CORROBORATION 15   // same MAC seen on both BLE and WiFi
// Protocol matches are unambiguous: an ASTM Remote-ID beacon IS a drone, an
// Apple Find My "offline finding" advert IS a tracker. Presence alone is the
// detection — no need to decode operator GPS just to sound the buzzer.
#define W_DRONE      90
#define W_TRACKER    80
// A single weak, non-Flock-specific signal (a broad OUI prefix, or the Lite-On
// vendor IE that rides countless consumer WiFi chips) is noise on its own. Only
// list a device that clears 60 — i.e. one specific signal (SSID/UUID/name at
// 70-80) or two corroborating weak ones (OUI 30 + IE 30, or +15 cross-protocol).
// ponytail: this is the noise floor; lower it if real devices are being missed.
// Overridable at build time (-D CONF_LIST_MIN=0) so a bench test can see the
// full unfiltered harvest -- e.g. comparing antennas across two boards.
#ifndef CONF_LIST_MIN
#define CONF_LIST_MIN   60
#endif

// Listing and alerting are different questions and must not share a threshold.
// Confidence is a SUM, so two individually-meaningless hints add up to a
// specific-looking score: a consumer device on a listed OUI (30) that also
// carries the Lite-On vendor IE (30) lands on exactly 60 and used to sound the
// buzzer. Field-confirmed: the alarm fired repeatedly on a route with no ALPR
// anywhere near it. So the buzzer now tests the STRONGEST SINGLE signal
// (`bestWeight`), not the sum — it must be one signal that identifies something
// on its own (SSID 80, device name 70, service UUID 70), never a pile of
// generic ones. The sum still drives the list and the tier, where being
// generous is free.
#define CONF_ALERT_MIN  70

// Now that the mode harvests everything rather than only signature hits, the
// target list needs the same lifecycle every other mode already had.
#define WATCHERS_STALE_MS    120000  // drop devices unheard for 2 min
#define WATCHERS_MAX_REPORT  40      // per-push cap; selection is round-robin

static String tierForConfidence(int confidence) {
    if (confidence >= 75) return "Confirmed";
    if (confidence >= 45) return "Likely";
    return "Possible";
}

// Headless alerting.
//
// With no phone connected the buzzer is the entire user interface, so it has to
// work off both radios — the strongest Flock signal there is (an SSID match,
// weight 80) exists only on the Wi-Fi side, and used to make no sound at all
// because the only triggerAlarm() calls lived in the BLE callback.
//
// Detections record the alert here instead of buzzing directly, and the 1 Hz
// task acts on it. Two reasons: the Wi-Fi promiscuous callback must never block
// (triggerAlarm takes a 10 ms mutex), and draining it once per tick naturally
// rate-limits a dense area to one alert per second instead of a continuous
// scream. Highest confidence seen in the interval wins.
//
// NOTE: this is inherently a *signature* alarm. The geospatial "is it bolted
// down" test needs GPS, which lives in the phone until Tier 3, so headless can
// only ever shout about brands it already knows. That's the deal, and it's
// still worth having.
static volatile int pendingAlertConf = 0;
// Which buzzer "word" the winning signal earns. The strongest single signal in
// the interval sets both the confidence and the category, so the sound matches
// what actually tripped the alarm.
static volatile AlertCategory pendingAlertCat = ALERT_GENERIC;

static void noteAlert(int weight, const char* category) {
    if (weight < CONF_ALERT_MIN) return;
    if (weight > pendingAlertConf) {
        pendingAlertConf = weight;
        pendingAlertCat = alertCategoryFromName(category);
    }
}

/**
 * @brief Match a device against one signature rule. Returns an accumulated
 * confidence weight (0 = no match). A rule ANDs its non-empty conditions; the
 * returned weight is the sum of the matched conditions' weights (capped 100).
 */
static int matchDeviceAgainstRule(NimBLEAdvertisedDevice* dev, const WatcherSignature& sig, String& outMatchedRule, String& outCategory) {
    int weight = 0;

    // 1. Check OUI (MAC Prefix)
    if (sig.oui.length() > 0) {
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
            return 0;
        }
        weight += W_OUI;
    }

    // 2. Check Manufacturer ID
    if (sig.mfgId.length() > 0) {
        if (!dev->haveManufacturerData()) {
            return 0;
        }
        std::string mfg = dev->getManufacturerData();
        if (mfg.length() < 2) {
            return 0;
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
            return 0;
        }
        weight += W_MFG;
    }

    // 3. Check Device Name Substring
    if (sig.deviceName.length() > 0) {
        if (!dev->haveName()) {
            return 0;
        }
        String devName = String(dev->getName().c_str());
        devName.toLowerCase();
        String targetName = sig.deviceName;
        targetName.toLowerCase();

        if (devName.indexOf(targetName) < 0) {
            return 0;
        }
        weight += W_NAME;
    }

    // 4. Check Service UUID
    if (sig.serviceUuid.length() > 0) {
        if (!dev->haveServiceUUID()) {
            return 0;
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
            return 0;
        }
        weight += W_UUID;
    }

    if (weight == 0) {
        return 0;  // rule had no conditions
    }

    outMatchedRule = sig.name.length() > 0 ? sig.name : "Matched Signature";
    outCategory = sig.category.length() > 0 ? sig.category : "Surveillance";
    return weight > 100 ? 100 : weight;
}

// Protocol detectors. The tracker check is presence-only (an AirTag's payload
// is a rotating public key; there is nothing to decode). The drone check is a
// full ASTM F3411 decode via the stock opendroneid reference implementation —
// Remote ID is a broadcast standard whose whole point is to be readable, so a
// drone hands us its serial, its position and the operator's position for free.
//
// ODID_UAS_Data is ~1 KB. Both callbacks run on tight stacks (the NimBLE scan
// task and the Wi-Fi promiscuous callback), so these are file-static rather
// than locals. bleUas is only touched inside the watchersMutex block; wifiUas
// only from the single-threaded promiscuous callback. Do not cross them.
static ODID_UAS_Data bleUas;
static ODID_UAS_Data wifiUas;

// True if a decode produced anything worth reporting.
static bool odidUseful(const ODID_UAS_Data& d) {
    return d.BasicIDValid[0] || d.LocationValid || d.SystemValid ||
           d.OperatorIDValid || d.SelfIDValid;
}

// Feed one ODID payload to the decoder, picking packed vs single message.
static void odidDecodeInto(ODID_UAS_Data& out, const uint8_t* data, size_t len) {
    if (len == 0) return;
    if ((data[0] & 0xF0) == (ODID_MESSAGETYPE_PACKED << 4)) {
        odid_message_process_pack(&out, (uint8_t*)data, len);
    } else {
        decodeOpenDroneID(&out, (uint8_t*)data);
    }
}

// Copy a decoded frame onto a target. Fields are only overwritten when this
// frame actually carried them — Remote ID arrives as a stream of different
// message types, so a Location-only frame must not blank the serial we learned
// from an earlier Basic ID frame.
static void applyDroneData(WatcherTargetInfo& t, const ODID_UAS_Data& d) {
    t.hasDrone = true;
    if (d.BasicIDValid[0] && d.BasicID[0].UASID[0]) t.uasId = String(d.BasicID[0].UASID);
    if (d.OperatorIDValid && d.OperatorID.OperatorId[0])  t.operatorId = String(d.OperatorID.OperatorId);
    if (d.SelfIDValid && d.SelfID.Desc[0])                t.selfId = String(d.SelfID.Desc);
    if (d.LocationValid) {
        t.droneLat  = d.Location.Latitude;
        t.droneLng  = d.Location.Longitude;
        t.altMsl    = d.Location.AltitudeGeo;
        t.heightAgl = d.Location.Height;
        t.speed     = d.Location.SpeedHorizontal;
        t.heading   = d.Location.Direction;
    }
    if (d.SystemValid) {
        t.opLat = d.System.OperatorLatitude;
        t.opLng = d.System.OperatorLongitude;
    }
}

// Decode ASTM Remote ID out of a BLE advert (UUID 0xFFFA in AD type 0x16,
// Service Data - 16-bit UUID). Returns true and fills `out` on a useful decode.
static bool bleDecodeRemoteId(NimBLEAdvertisedDevice* dev, ODID_UAS_Data& out) {
    uint8_t* payload = dev->getPayload();
    size_t len = dev->getPayloadLength();
    if (!payload || len < 4) return false;
    size_t offset = 0;
    while (offset + 1 < len) {
        uint8_t adLen = payload[offset];
        if (adLen == 0 || offset + 1 + adLen > len) break;
        uint8_t adType = payload[offset + 1];
        if (adType == 0x16 && adLen >= 3) {
            uint16_t uuid = payload[offset + 2] | (payload[offset + 3] << 8);
            if (uuid == 0xFFFA) {
                // Optionally followed by the Open Drone ID application code
                // (0x0D); skip it when present.
                const uint8_t* data;
                size_t dataLen;
                if (adLen >= 4 && payload[offset + 4] == 0x0D) {
                    data = &payload[offset + 5];
                    dataLen = adLen - 4;
                } else {
                    data = &payload[offset + 4];
                    dataLen = adLen - 3;
                }
                memset(&out, 0, sizeof(out));
                odidDecodeInto(out, data, dataLen);
                // A malformed or unsupported frame still means "a drone is
                // broadcasting Remote ID here", which is the alert-worthy fact.
                // Report presence either way; the decoded detail is a bonus.
                return true;
            }
        }
        offset += (adLen + 1);
    }
    return false;
}

// True if a BLE advert is an Apple "Find My" offline-finding beacon (an AirTag
// or other Find My tracker). Apple manufacturer data (company 0x004C) with
// message type 0x12. Deliberately NOT a bare 0x004C match — that is every
// iPhone/AirPod in range.
static bool bleIsAirtag(NimBLEAdvertisedDevice* dev) {
    if (!dev->haveManufacturerData()) return false;
    std::string mfg = dev->getManufacturerData();
    if (mfg.length() < 3) return false;
    uint16_t company = static_cast<uint8_t>(mfg[0]) | (static_cast<uint8_t>(mfg[1]) << 8);
    return company == 0x004C && static_cast<uint8_t>(mfg[2]) == 0x12;
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

        // Hunting: every advert from the target refreshes the click rate. Done
        // before the mutex so a busy detector never delays the feedback you are
        // physically walking on.
        if (huntMac.length() > 0 && huntMac.equalsIgnoreCase(mac)) {
            updateGeigerRssi(rssi);
        }

        if (xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            // Accumulate confidence across every rule this device matches, so
            // corroborating signals (e.g. OUI + service UUID) add up. Keep the
            // rule/category from the single strongest match for display.
            int confidence = 0;
            int bestWeight = 0;
            String matchedRule = "";
            String matchedCategory = "";

            for (const auto& sig : loadedSignatures) {
                String r = "", c = "";
                int w = matchDeviceAgainstRule(advertisedDevice, sig, r, c);
                if (w > 0) {
                    confidence += w;
                    if (w > bestWeight) {
                        bestWeight = w;
                        matchedRule = r;
                        matchedCategory = c;
                    }
                }
            }

            // Protocol detectors (not signature rules): presence alone is a
            // strong, unambiguous match, so they set the category directly.
            bool droneDecoded = false;
            if (bleDecodeRemoteId(advertisedDevice, bleUas)) {
                droneDecoded = odidUseful(bleUas);
                confidence += W_DRONE;
                if (W_DRONE > bestWeight) {
                    bestWeight = W_DRONE;
                    matchedRule = "Remote ID Drone";
                    matchedCategory = "Drone";
                }
            } else if (bleIsAirtag(advertisedDevice)) {
                confidence += W_TRACKER;
                if (W_TRACKER > bestWeight) {
                    bestWeight = W_TRACKER;
                    matchedRule = "Apple Find My Tracker";
                    matchedCategory = "Tracker";
                }
            }

            if (confidence > 100) confidence = 100;

            // The confidence score is an annotation, not a gate: the phone
            // classifies on geospatial persistence (a radio pinned to one place
            // across repeat visits is infrastructure), which only works if it
            // sees everything the radio hears — including vendors not on any
            // list. CONF_LIST_MIN now only decides whether the buzzer fires.
            {
                bool found = false;
                for (auto& target : trackedTargets) {
                    if (target.mac.equalsIgnoreCase(mac)) {
                        target.rssi = rssi;
                        target.lastSeenMs = now;
                        target.count++;
                        // Corroboration: this MAC was previously seen over WiFi.
                        int merged = confidence;
                        if (target.protocol == "WiFi" || target.protocol == "BLE+WiFi") {
                            merged = confidence + W_CORROBORATION;
                            target.protocol = "BLE+WiFi";
                        } else {
                            target.protocol = "BLE";
                        }
                        if (merged > 100) merged = 100;
                        if (merged > target.confidence) target.confidence = merged;
                        target.tier = tierForConfidence(target.confidence);
                        if (devName.length() > 0) target.name = devName;
                        // Don't let a later non-matching advert wipe a category
                        // an earlier rule match established.
                        if (matchedCategory.length() > 0) {
                            target.type = matchedCategory;
                            target.matchedRule = matchedRule;
                        }
                        if (droneDecoded) applyDroneData(target, bleUas);
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
                    newTarget.confidence = confidence;
                    newTarget.tier = tierForConfidence(confidence);
                    newTarget.lastReportedMs = 0;
                    if (droneDecoded) applyDroneData(newTarget, bleUas);
                    trackedTargets.push_back(newTarget);

                    // Log and alert only on a signature hit — everything else
                    // is harvested silently for the phone to classify.
                    if (confidence >= CONF_LIST_MIN) {
                        ESP_LOGI(TAG, "[SURVEILLANCE] MAC: %s, Rule: %s, Cat: %s, Conf: %d (%s), RSSI: %d",
                                 mac.c_str(), matchedRule.c_str(), matchedCategory.c_str(),
                                 confidence, newTarget.tier.c_str(), rssi);
                        noteAlert(bestWeight, matchedCategory.c_str());   // strongest single signal + its category
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
    // Hop all US 2.4 GHz channels so a Flock node beaconing off 1/6/11 isn't
    // missed. (ESP32-S3 is 2.4 GHz only.)
    const uint8_t channels[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
    int chIndex = 0;
    while (watchersRunning) {
        vTaskDelay(pdMS_TO_TICKS(150));
        if (!watchersRunning) break;
        esp_wifi_set_channel(channels[chIndex], WIFI_SECOND_CHAN_NONE);
        chIndex = (chIndex + 1) % (int)(sizeof(channels) / sizeof(channels[0]));
    }
    watchersWifiHopTaskHandle = NULL;
    vTaskDelete(NULL);
}

// Insert/update a target known only from a Remote ID decode. Used by the Wi-Fi
// NAN action-frame path, which carries no SSID, no vendor IE and no OUI worth
// scoring — the decode itself is the whole identification.
static void upsertDroneTarget(const String& mac, int rssi, const char* proto,
                              const ODID_UAS_Data& d) {
    if (watchersMutex == NULL) return;
    if (xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(10)) != pdTRUE) return;
    uint32_t now = millis();
    bool found = false;
    for (auto& t : trackedTargets) {
        if (t.mac.equalsIgnoreCase(mac)) {
            t.rssi = rssi;
            t.lastSeenMs = now;
            t.count++;
            if (W_DRONE > t.confidence) t.confidence = W_DRONE;
            t.tier = tierForConfidence(t.confidence);
            t.type = "Drone";
            t.matchedRule = "Remote ID Drone";
            applyDroneData(t, d);
            found = true;
            break;
        }
    }
    if (!found) {
        WatcherTargetInfo t;
        t.mac = mac;
        t.type = "Drone";
        t.matchedRule = "Remote ID Drone";
        t.rssi = rssi;
        t.firstSeenMs = now;
        t.lastSeenMs = now;
        t.count = 1;
        t.protocol = proto;
        t.confidence = W_DRONE;
        t.tier = tierForConfidence(W_DRONE);
        t.lastReportedMs = 0;
        applyDroneData(t, d);
        trackedTargets.push_back(t);
        ESP_LOGI(TAG, "[DRONE - %s] MAC: %s, UAS: %s, RSSI: %d",
                 proto, mac.c_str(), t.uasId.c_str(), rssi);
        noteAlert(W_DRONE, "Drone");
    }
    xSemaphoreGive(watchersMutex);
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

    // Remote ID over Wi-Fi NAN: an Action frame addressed to the ASTM NAN
    // cluster 51:6F:9A:01:00:00. The opendroneid helper validates and unpacks
    // the whole frame, including the transmitter MAC (which is inside the
    // service descriptor, not the 802.11 header).
    {
        static const uint8_t nanDest[6] = {0x51, 0x6F, 0x9A, 0x01, 0x00, 0x00};
        if (memcmp(nanDest, addr1, 6) == 0) {
            memset(&wifiUas, 0, sizeof(wifiUas));
            char nanMacRaw[6] = {0};
            if (odid_wifi_receive_message_pack_nan_action_frame(&wifiUas, nanMacRaw, payload, length) == 0
                && odidUseful(wifiUas)) {
                char nanMacBuf[20];
                snprintf(nanMacBuf, sizeof(nanMacBuf), "%02X:%02X:%02X:%02X:%02X:%02X",
                         (uint8_t)nanMacRaw[0], (uint8_t)nanMacRaw[1], (uint8_t)nanMacRaw[2],
                         (uint8_t)nanMacRaw[3], (uint8_t)nanMacRaw[4], (uint8_t)nanMacRaw[5]);
                upsertDroneTarget(String(nanMacBuf), rssi, "WiFi", wifiUas);
            }
            return;
        }
    }

    // Probe Request (subtype 4) or Beacon (subtype 8) or Probe Response (subtype 5)
    if (ftype == 0 && (fsubtype == 4 || fsubtype == 5 || fsubtype == 8)) {
        if (watchersMutex == NULL) return;
        
        int wifiConfidence = 0;
        int bestWeight = 0;
        String matchedRule = "";
        String matchedCategory = "";
        bool droneDecoded = false;

        // 1. Check OUI (weak signal)
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
                        wifiConfidence += W_WIFI_OUI;
                        if (W_WIFI_OUI > bestWeight) {
                            bestWeight = W_WIFI_OUI;
                            matchedRule = sig.name.length() > 0 ? sig.name : "WiFi OUI Match";
                            matchedCategory = sig.category;
                        }
                        break;
                    }
                }
            }
            xSemaphoreGive(watchersMutex);
        }

        // 2. Strong signals: Lite-On Flock vendor IE (50:6F:9A) and Flock SSIDs.
        // Scanned unconditionally so they add to (not replace) the OUI weight.
        if (length > 24 + 12) {
            int offset = (fsubtype == 4) ? 24 : 36;
            int body_len = length - offset - 4; // -4 for FCS
            const uint8_t *body = payload + offset;
            bool ieHit = false, ssidHit = false;

            int b = 0;
            while (b < body_len - 1) {
                uint8_t id = body[b];
                uint8_t elen = body[b+1];
                if (b + 2 + elen > body_len) break;

                if (!ieHit && id == 221 && elen >= 4 && body[b+2] == 0x50 && body[b+3] == 0x6F && body[b+4] == 0x9A) {
                    ieHit = true;
                    wifiConfidence += W_WIFI_IE;
                    // Deliberately does NOT set a category: 50:6F:9A is Lite-On's
                    // general OUI, present in countless consumer WiFi chips. It
                    // is a weak corroborating hint, not a vendor identification.
                    if (W_WIFI_IE > bestWeight) { bestWeight = W_WIFI_IE; matchedRule = "Lite-On Vendor IE (weak)"; }
                }

                // Drone Remote ID over WiFi Beacon: ASTM (90:3A:E6) or French
                // (FA:0B:BC) vendor IE, decoded in full.
                if (id == 221 && elen >= 6 &&
                    ((body[b+2] == 0x90 && body[b+3] == 0x3A && body[b+4] == 0xE6) ||
                     (body[b+2] == 0xFA && body[b+3] == 0x0B && body[b+4] == 0xBC))) {
                    wifiConfidence += W_DRONE;
                    if (W_DRONE > bestWeight) {
                        bestWeight = W_DRONE;
                        matchedRule = "Remote ID Drone";
                        matchedCategory = "Drone";
                    }
                    // The ODID payload starts after OUI (3) + vendor type (1) +
                    // message counter (1). Length comes from this element's own
                    // elen — Sky Sweeper used "everything to end of frame",
                    // which fed the decoder every subsequent IE plus the FCS as
                    // if it were drone payload.
                    int odidLen = (int)elen - 5;
                    if (odidLen > 0) {
                        memset(&wifiUas, 0, sizeof(wifiUas));
                        odidDecodeInto(wifiUas, body + b + 7, (size_t)odidLen);
                        droneDecoded = odidUseful(wifiUas);
                    }
                }

                if (!ssidHit && id == 0 && elen > 0 && elen <= 32) {
                    char ssid[33] = {0};
                    memcpy(ssid, body + b + 2, elen);
                    String ssidStr = String(ssid);
                    ssidStr.toLowerCase();
                    if (ssidStr.indexOf("flock") >= 0 || ssidStr.indexOf("fs_") >= 0 || ssidStr.indexOf("pigvision") >= 0) {
                        ssidHit = true;
                        wifiConfidence += W_WIFI_SSID;
                        if (W_WIFI_SSID > bestWeight) {
                            bestWeight = W_WIFI_SSID;
                            matchedRule = "Flock SSID Signature";
                            matchedCategory = "Flock Safety";   // SSID match IS vendor-specific
                        }
                    }
                }

                b += 2 + elen;
            }
        }

        if (wifiConfidence > 100) wifiConfidence = 100;

        // Same as the BLE path: harvest everything, score is an annotation.
        if (xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            bool found = false;
            uint32_t now = millis();
            for (auto& target : trackedTargets) {
                if (target.mac.equalsIgnoreCase(mac)) {
                    target.rssi = rssi;
                    target.lastSeenMs = now;
                    target.count++;
                    int merged = wifiConfidence;
                    // Corroboration: this MAC was previously seen over BLE.
                    if (target.protocol == "BLE" || target.protocol == "BLE+WiFi") {
                        merged = wifiConfidence + W_CORROBORATION;
                        target.protocol = "BLE+WiFi";
                    } else {
                        target.protocol = "WiFi";
                    }
                    if (merged > 100) merged = 100;
                    if (merged > target.confidence) target.confidence = merged;
                    target.tier = tierForConfidence(target.confidence);
                    // Label by what actually matched. The old code stamped
                    // "Flock Safety" on every WiFi hit, so a Cradlepoint router
                    // or a stray ESP32 was reported as a Flock camera.
                    if (matchedRule.length() > 0) {
                        target.type = matchedCategory;
                        target.matchedRule = matchedRule;
                    }
                    if (droneDecoded) applyDroneData(target, wifiUas);
                    found = true;
                    break;
                }
            }
            if (!found) {
                WatcherTargetInfo newTarget;
                newTarget.mac = mac;
                newTarget.name = "";
                newTarget.type = matchedCategory;
                newTarget.matchedRule = matchedRule;
                newTarget.rssi = rssi;
                newTarget.firstSeenMs = now;
                newTarget.lastSeenMs = now;
                newTarget.count = 1;
                newTarget.protocol = "WiFi";
                newTarget.confidence = wifiConfidence;
                newTarget.tier = tierForConfidence(wifiConfidence);
                newTarget.lastReportedMs = 0;
                if (droneDecoded) applyDroneData(newTarget, wifiUas);
                trackedTargets.push_back(newTarget);

                if (wifiConfidence >= CONF_LIST_MIN) {
                    ESP_LOGI(TAG, "[SURVEILLANCE - WIFI] MAC: %s, Rule: %s, Conf: %d (%s), RSSI: %d",
                             mac.c_str(), matchedRule.c_str(), wifiConfidence, newTarget.tier.c_str(), rssi);
                    noteAlert(bestWeight, matchedCategory.c_str());   // strongest single signal + its category
                }
            }
            xSemaphoreGive(watchersMutex);
        }
    }
}

void setHuntTarget(const String& mac) {
    huntMac = mac;
    huntMac.toUpperCase();
    if (huntMac.length() > 0) {
        // -90 is the "far away" end of the clicker's range; the first advert
        // from the target replaces it within a scan interval.
        setGeigerTargetLock(true, -90);
        ESP_LOGI(TAG, "Hunting %s", huntMac.c_str());
    } else {
        setGeigerTargetLock(false);
        ESP_LOGI(TAG, "Hunt cleared");
    }
}

String getHuntTarget() {
    return huntMac;
}

void requestRing(const String& mac) {
    pendingRingMac = mac;
    pendingRingMac.toUpperCase();
}

// Make a suspected tracker announce itself, so you can find the thing that is
// following you. Deliberately not a general GATT write primitive: the MAC is
// the only parameter, and the service (Immediate Alert 0x1802), characteristic
// (Alert Level 0x2A06) and value (0x02 = high alert) are fixed here. The old
// build exposed arbitrary service/char/hex writes plus an advertisement
// spoofer; both are gone and should stay gone.
static void performRing(const String& mac) {
    ESP_LOGI(TAG, "Ringing %s", mac.c_str());
    // A GATT connection needs the radio to itself. pauseBle() is the same hook
    // the NUS server uses; the scan restarts in the same call below whatever
    // happens, so a failed connect can never leave the detector deaf.
    pauseBle(true);

    NimBLEClient* client = NimBLEDevice::createClient();
    bool ok = false;
    if (client) {
        // Bound the attempt. This runs ON the 1 Hz task with the scan paused,
        // so every second spent here is a second of no telemetry and a deaf
        // detector. NimBLE's default is 30 s, and a "tracker" that turns out
        // to have no Immediate Alert service — or has wandered out of range —
        // takes the full timeout. Measured on the bench: a ring at the default
        // stalled the push loop long enough to look like a crash.
        client->setConnectTimeout(5);
        NimBLEAddress addr(std::string(mac.c_str()), BLE_ADDR_RANDOM);
        if (client->connect(addr, false)) {
            NimBLERemoteService* svc = client->getService(NimBLEUUID((uint16_t)0x1802));
            if (svc) {
                NimBLERemoteCharacteristic* ch = svc->getCharacteristic(NimBLEUUID((uint16_t)0x2A06));
                if (ch) {
                    uint8_t high = 0x02;
                    ok = ch->writeValue(&high, 1, false);
                }
            }
            client->disconnect();
        }
        NimBLEDevice::deleteClient(client);
    }
    ESP_LOGI(TAG, "Ring %s: %s", mac.c_str(), ok ? "sent" : "failed");

    pauseBle(false);
}

static void watchersPeriodicTask(void *pvParameters) {
    (void)pvParameters;
    while (watchersRunning) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (!watchersRunning) break;

        // Sound anything the radios flagged since the last tick. Done here, off
        // the detection callbacks, so the Wi-Fi promiscuous handler stays fast
        // and a dense area gets one alert per second rather than a continuous
        // tone. triggerAlarm() itself also refuses to retrigger while an alarm
        // is still sounding.
        int alert = pendingAlertConf;
        AlertCategory alertCat = pendingAlertCat;
        pendingAlertConf = 0;
        // The buzzer pattern is the identification: each category is a distinct
        // "word" you learn by ear. Confidence already gated the alert in
        // noteAlert(); here we just sound whichever category won the interval.
        if (alert >= CONF_ALERT_MIN) triggerCategoryAlert(alertCat);

        // Ring runs here, on a real task with a real stack, never on the BLE
        // write callback that asked for it.
        if (pendingRingMac.length() > 0) {
            String target = pendingRingMac;
            pendingRingMac = "";
            performRing(target);
        }

        // Prune stale targets. This mode used to be the only one that never
        // expired anything, so trackedTargets grew for the whole session.
        if (watchersMutex != NULL && xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
            uint32_t now = millis();
            for (size_t i = 0; i < trackedTargets.size(); ) {
                if (now - trackedTargets[i].lastSeenMs > WATCHERS_STALE_MS) {
                    trackedTargets.erase(trackedTargets.begin() + i);
                } else {
                    i++;
                }
            }
            xSemaphoreGive(watchersMutex);
        }

        String jsonStr = getWatchersTargetsJson();
        sendBleSerial(jsonStr);
        if (Serial) Serial.println(jsonStr);   // skip the USB mirror when no host is attached
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

        int rejected = 0;
        for (JsonObject s : sigs) {
            WatcherSignature sig;
            sig.name = s["name"] | "";
            sig.category = s["category"] | "";
            sig.oui = s["oui"] | "";
            sig.mfgId = s["mfg_id"] | "";
            sig.deviceName = s["device_name"] | "";
            sig.serviceUuid = s["service_uuid"] | "";

            // A prefix with the locally-administered bit (0x02) set is not a
            // vendor OUI at all — it is the signature of a *randomized* MAC, so
            // it matches random phones. Reject it however it got here, including
            // via a rule set pushed from the app.
            if (sig.oui.length() >= 2) {
                char h[3] = { sig.oui[0], sig.oui[1], 0 };
                long firstOctet = strtol(h, NULL, 16);
                if (firstOctet & 0x02) {
                    ESP_LOGW(TAG, "Rejecting locally-administered OUI rule '%s' (%s)",
                             sig.name.c_str(), sig.oui.c_str());
                    rejected++;
                    continue;
                }
            }
            loadedSignatures.push_back(sig);
        }
        if (rejected > 0) ESP_LOGW(TAG, "Rejected %d locally-administered OUI rule(s).", rejected);
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
    // Filter in hardware. The callback only ever handles WIFI_PKT_MGMT, so
    // without this every data/ctrl frame in the air reaches the ISR just to be
    // dropped by the software check.
    wifi_promiscuous_filter_t wfilter = { .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT };
    esp_wifi_set_promiscuous_filter(&wfilter);
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

    // This mode used to leave promiscuous mode and the rx callback running
    // after a mode switch; only watchersRunning=false kept the callback quiet.
    esp_wifi_set_promiscuous(false);
    esp_wifi_set_promiscuous_rx_cb(NULL);

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
    doc["name"] = "MODE_DETECTOR";
    // Carried on every push so flash.py --auto can read the tier back over
    // serial (the old selector heartbeat that used to carry it is gone).
    doc["tier"] = getTier();

    if (watchersMutex != NULL && xSemaphoreTake(watchersMutex, pdMS_TO_TICKS(200)) == pdTRUE) {

        // Report only signature matches. The phone used to classify the full
        // harvest geospatially (a radio pinned to one place across visits =
        // infrastructure), so the device shipped every MAC it heard. That
        // classifier — and its location history — is gone for opsec, so the
        // live scope now shows exactly what tripped the detector: confirmed
        // matches, nothing else. Round-robin by staleness still fairly rotates
        // when matches exceed the per-push cap (rare).
        std::vector<size_t> order;
        for (size_t i = 0; i < trackedTargets.size(); i++) {
            if (trackedTargets[i].confidence >= CONF_LIST_MIN) order.push_back(i);
        }
        std::sort(order.begin(), order.end(), [](size_t a, size_t b) {
            return trackedTargets[a].lastReportedMs < trackedTargets[b].lastReportedMs;
        });
        doc["count"] = order.size();
        if (order.size() > WATCHERS_MAX_REPORT) order.resize(WATCHERS_MAX_REPORT);

        uint32_t nowMs = millis();
        JsonArray targetsArr = doc["targets"].to<JsonArray>();
        for (size_t idx : order) {
            WatcherTargetInfo& t = trackedTargets[idx];
            t.lastReportedMs = nowMs;
            JsonObject obj = targetsArr.add<JsonObject>();
            obj["mac"] = t.mac;
            // Most harvested devices match no rule, so skip the empty strings —
            // at 40 targets/sec those bytes are pure BLE airtime.
            if (t.name.length() > 0)        obj["name"] = t.name;
            if (t.type.length() > 0)        obj["type"] = t.type;
            if (t.matchedRule.length() > 0) obj["matched_rule"] = t.matchedRule;
            obj["rssi"] = t.rssi;
            // first_seen_ms / last_seen_ms deliberately not sent: the app
            // tracks its own wall-clock timing in sightStore and ignored these,
            // and at ~40 targets they were about a quarter of the payload.
            obj["count"] = t.count;
            obj["protocol"] = t.protocol.length() > 0 ? t.protocol : "BLE";
            obj["confidence"] = t.confidence;
            obj["tier"] = t.tier.length() > 0 ? t.tier : "Possible";

            // Decoded Remote ID, drones only. Telemetry is the tightest budget
            // on this board, so each field ships once and only when it holds a
            // real value — ODID's sentinels (0/0 for position, -1000 m, 361 deg)
            // mean "unknown" and are dropped rather than sent. Sky Sweeper used
            // to emit every field twice under two names for app compatibility;
            // one name per field here.
            if (t.hasDrone) {
                if (t.uasId.length() > 0)      obj["uas_id"] = t.uasId;
                if (t.operatorId.length() > 0) obj["operator_id"] = t.operatorId;
                if (t.selfId.length() > 0)     obj["self_id"] = t.selfId;
                if (t.droneLat != 0.0 || t.droneLng != 0.0) {
                    obj["lat"] = t.droneLat;
                    obj["lng"] = t.droneLng;
                }
                if (t.altMsl    > -1000) obj["alt"] = t.altMsl;
                if (t.heightAgl > -1000) obj["agl"] = t.heightAgl;
                if (t.speed     > 0)     obj["speed"] = t.speed;
                if (t.heading   < 361)   obj["heading"] = t.heading;
                if (t.opLat != 0.0 || t.opLng != 0.0) {
                    obj["op_lat"] = t.opLat;
                    obj["op_lng"] = t.opLng;
                }
            }
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

/**
 * @brief Delete /data/signatures.json and reload, regenerating the built-in
 * defaults. The counterpart to updateWatchersSignaturesJson(): once a rule set
 * has been pushed there is otherwise no way back to the defaults short of a
 * full factory reset (BOOT held 5 s), which also wipes the mode and target lock.
 */
void resetWatchersSignaturesToDefaults() {
    LittleFS.remove(SIG_FILE_PATH);
    loadWatchersSignatures();   // ensureSignaturesFileExists() rewrites defaults
    ESP_LOGI(TAG, "Signature rules reset to built-in defaults.");
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
    // Stamp the current schema version. Without it ensureSignaturesFileExists()
    // — which loadWatchersSignatures() calls below — reads version 0, decides
    // the file predates the current defaults, and deletes it. That silently
    // threw away every pushed rule set and made this command a no-op.
    // A rule set pushed by a client running today's protocol is current by
    // definition; it will still be regenerated if SIG_SCHEMA_VERSION is bumped
    // later, which is the intended trade (stale poisoned defaults are worse).
    outDoc["version"] = SIG_SCHEMA_VERSION;
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
