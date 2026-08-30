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
 * @return JSON string formatted for GET /api/watchers/targets
 */
String getWatchersTargetsJson();

/**
 * @brief Get JSON representation of all signature rules from LittleFS
 * @return JSON string formatted for GET /api/watchers/signatures
 */
String getWatchersSignaturesJson();

/**
 * @brief Update signature database in LittleFS and reload rules in memory
 * @param jsonContent New signature JSON string or object
 * @return true if updated and reloaded successfully, false otherwise
 */
bool updateWatchersSignaturesJson(const String& jsonContent);

/**
 * @brief Load signature rules from LittleFS (/data/signatures.json)
 */
void loadWatchersSignatures();

#endif // MODE_WATCHERS_WATCH_H
