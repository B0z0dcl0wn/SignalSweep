#ifndef MODE_SHADOW_H
#define MODE_SHADOW_H

#include <Arduino.h>
#include <vector>

/**
 * @brief A device sighting. Shadow reports raw sightings; the app correlates
 * them against phone GPS to decide whether something is following you.
 */
struct ShadowSighting {
    String mac;
    String name;
    String protocol;   // "BLE" | "WiFi"
    int rssi;
    uint32_t firstSeenMs;
    uint32_t lastSeenMs;
    uint32_t count;
};

/**
 * @brief Start Shadow mode (BLE scan + WiFi promiscuous, reporting every MAC)
 */
void startShadow();

/**
 * @brief Stop Shadow mode cleanly
 */
void stopShadow();

/**
 * @brief Check if Shadow mode is currently active
 */
bool isShadowActive();

/**
 * @brief JSON of current sightings, sent to the app over BLE NUS
 */
String getShadowSightingsJson();

#endif // MODE_SHADOW_H
