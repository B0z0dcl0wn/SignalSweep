#ifndef MODE_WATCHERS_WATCH_H
#define MODE_WATCHERS_WATCH_H

#include <Arduino.h>
#include <vector>

/**
 * @brief Information about a signature rule for surveillance device detection
 */
struct WatcherSignature {
    String name;
    String category;
    String oui;
    String mfgId;
    String deviceName;
    String serviceUuid;
};

/**
 * @brief Information about a detected surveillance target
 */
struct WatcherTargetInfo {
    String mac;
    String name;
    String type;
    String matchedRule;
    String protocol;
    int rssi;
    uint32_t firstSeenMs;
    uint32_t lastSeenMs;
    uint32_t count;
    int confidence;   // 0-100, accumulated across matching signals
    String tier;      // "Confirmed" | "Likely" | "Possible"
    uint32_t lastReportedMs;  // round-robin cursor: oldest reported goes first

    // Decoded ASTM F3411 Remote ID, populated only for drones (hasDrone).
    // Everything else leaves this zeroed and it never reaches the wire — the
    // 1 Hz push is the tightest budget on the board, so these fields are
    // emitted per-target only when hasDrone is set.
    // Defaults matter: the struct is filled field-by-field at both call sites
    // and has no constructor, so anything not assigned there would otherwise be
    // stack garbage — and garbage in hasDrone puts junk coordinates on the wire.
    bool   hasDrone = false;
    String uasId;                    // Basic ID / serial
    String operatorId;               // Operator ID (registration)
    String selfId;                   // free-text description the operator chose
    double droneLat = 0, droneLng = 0;  // 0/0 == no value (ODID's own "unknown")
    float  altMsl    = -1000;        // m WGS84-HAE, -1000 == unknown
    float  heightAgl = -1000;        // m above take-off, -1000 == unknown
    float  speed     = 0;            // m/s horizontal
    float  heading   = 361;          // degrees true, 361 == unknown
    double opLat = 0, opLng = 0;     // pilot/operator position, 0/0 == no value
};

/**
 * @brief Start Watcher's Watch mode (loads signatures, starts continuous BLE scan & target tracking)
 */
void startWatchersWatch();

/**
 * @brief Stop Watcher's Watch mode cleanly (stops BLE scan)
 */
void stopWatchersWatch();

/**
 * @brief Check if Watcher's Watch mode is currently active
 * @return true if running, false otherwise
 */
bool isWatchersWatchActive();

/**
 * @brief Get JSON representation of all tracked surveillance targets
 * @return JSON string sent to the app over BLE NUS via sendBleSerial()
 */
String getWatchersTargetsJson();

/**
 * @brief Get JSON representation of all signature rules from LittleFS
 * @return JSON string sent to the app over BLE NUS via sendBleSerial()
 */
String getWatchersSignaturesJson();

/**
 * @brief Update signature database in LittleFS and reload rules in memory
 * @param jsonContent New signature JSON string or object
 * @return true if updated and reloaded successfully, false otherwise
 */
/**
 * @brief Reset the signature rules to the built-in defaults
 */
void resetWatchersSignaturesToDefaults();

bool updateWatchersSignaturesJson(const String& jsonContent);

/**
 * @brief Load signature rules from LittleFS (/data/signatures.json)
 */
void loadWatchersSignatures();

/**
 * @brief Hunt a MAC: its RSSI drives the Geiger clicker so a planted tracker
 * can be walked down by ear. Empty string clears. Detection never stops.
 */
void setHuntTarget(const String& mac);

/**
 * @brief The MAC currently being hunted, or "" if none.
 */
String getHuntTarget();

/**
 * @brief Queue a "ring the tracker" for this MAC. Performed on the 1 Hz task,
 * not on the caller's stack. MAC is the only parameter by design — see
 * performRing().
 */
void requestRing(const String& mac);

#endif // MODE_WATCHERS_WATCH_H
