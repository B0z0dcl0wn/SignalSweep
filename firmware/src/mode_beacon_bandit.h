#ifndef MODE_BEACON_BANDIT_H
#define MODE_BEACON_BANDIT_H

#include <Arduino.h>
#include <vector>

/**
 * @brief Information about a discovered BLE beacon target
 */
struct BanditTargetInfo {
    String mac;
    String name;
    String type;
    int rssi;
    uint32_t firstSeenMs;
    uint32_t lastSeenMs;
    uint32_t count;
    bool isLocked;
    uint8_t addrType;
};

/**
 * @brief Start Beacon Bandit mode (continuous BLE scan & target tracking)
 */
void startBeaconBandit();

/**
 * @brief Stop Beacon Bandit mode cleanly (stops BLE scan)
 */
void stopBeaconBandit();

/**
 * @brief Check if Beacon Bandit mode is currently active
 * @return true if running, false otherwise
 */
bool isBeaconBanditActive();

/**
 * @brief Lock on to a target MAC address for prioritized RSSI reporting (Geiger mode)
 * @param mac Target MAC address string (e.g. "AA:BB:CC:DD:EE:FF") or empty/none/unlock to clear lock
 * @return true if target lock state updated successfully
 */
bool setBanditLockTarget(const String& mac);

/**
 * @brief Get current locked target MAC address
 * @return MAC address string, or empty string if no lock
 */
String getBanditLockTarget();

/**
 * @brief Get JSON representation of all tracked targets
 * @return JSON string sent to the app over BLE NUS via sendBleSerial()
 */
String getBanditTargetsJson();

/**
 * @brief Enable or disable the strict beacon filter
 * @param active If true, ignores non-beacon devices. If false, shows all BLE devices.
 */
void setBanditFilter(bool active);

/**
 * @brief Write a GATT characteristic on a specific MAC. Backs the defensive
 * "Ring/Find" action (Immediate Alert Service 0x1802/0x2A06) that makes a
 * suspected tracker chirp so it can be physically located.
 */
void executeBleWrite(const String& mac, const String& serviceUuid, const String& charUuid, const String& hexVal);

#endif // MODE_BEACON_BANDIT_H
