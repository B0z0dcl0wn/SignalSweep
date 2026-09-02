#ifndef MODE_MANAGER_H
#define MODE_MANAGER_H

#include <Arduino.h>

// SignalSweep is one always-on detector. OperatingMode survives only because
// the hardware manager keys its idle LED colour and jingle defaults off it;
// MODE_WATCHERS_WATCH is the single detection mode. The other values are kept
// so the hardware manager's switch statements still compile with their existing
// cases, and are otherwise unused.
enum OperatingMode {
    MODE_SELECTOR = 0,
    MODE_BEACON_BANDIT = 1,
    MODE_WATCHERS_WATCH = 2,
    MODE_SKY_SWEEPER = 3,
    MODE_SHADOW = 4
};

/**
 * @brief Get human-readable string name for an operating mode
 */
const char* getModeName(OperatingMode mode);

/**
 * @brief Get current active operating mode
 */
OperatingMode getCurrentMode();

/**
 * @brief Request a transition to a new operating mode via FreeRTOS Queue
 * @param newMode The target operating mode
 * @return true if request was queued successfully, false otherwise
 */
bool setOperatingMode(OperatingMode newMode);

/**
 * @brief Persist the hardware tier and start the detector.
 */
void modeManagerInit();

/**
 * @brief Pause/resume BLE scanning globally
 */
void pauseBle(bool pause);

/**
 * @brief Pause/resume Wi-Fi scanning globally
 */
void pauseWifi(bool pause);

#endif // MODE_MANAGER_H
