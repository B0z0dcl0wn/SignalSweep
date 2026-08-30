#ifndef MODE_SKY_SWEEPER_H
#define MODE_SKY_SWEEPER_H

#include <Arduino.h>
#include <vector>

/**
 * @brief Information about a detected Open Drone ID (ODID) target
 */
struct SkySweeperTargetInfo {
    String mac;                 // MAC address string (e.g. "AA:BB:CC:DD:EE:FF")
    String uasId;               // Serial Number / UAS ID string (Basic ID)
    String operatorId;          // Operator / Pilot ID string
    String description;         // Self ID / Description string
    double latitude;            // Drone latitude (deg)
    double longitude;           // Drone longitude (deg)
    float altitudeMsl;          // Altitude MSL / Geo (m)
    float heightAgl;            // Height AGL (m)
    float speed;                // Horizontal speed (m/s)
    int heading;                // Heading / Direction (deg)
    double operatorLatitude;    // Operator / Pilot latitude (deg)
    double operatorLongitude;   // Operator / Pilot longitude (deg)
    int rssi;                   // Signal strength RSSI (dBm)
    String source;              // Detection source ("BLE", "WiFi Beacon", "WiFi NAN")
    uint32_t firstSeenMs;       // First seen timestamp in millis
    uint32_t lastSeenMs;        // Last seen timestamp in millis
    uint32_t count;             // Packet / Frame count
};

/**
 * @brief Start Sky Sweeper mode (starts NimBLE BLE scan & ESP32 WiFi promiscuous mode)
 */
void startSkySweeper();

/**
 * @brief Stop Sky Sweeper mode cleanly (stops BLE scan and disables WiFi promiscuous mode)
 */
void stopSkySweeper();

/**
 * @brief Check if Sky Sweeper mode is currently active
 * @return true if running, false otherwise
 */
bool isSkySweeperActive();

/**
 * @brief Get JSON representation of all detected drone targets
 * @return JSON string formatted for GET /api/skysweeper/targets
 */
String getSkySweeperTargetsJson();

#endif // MODE_SKY_SWEEPER_H
