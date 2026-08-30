#ifndef MODE_MANAGER_H
#define MODE_MANAGER_H

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

/**
 * @brief Operating modes for SignalSweep
 */
enum OperatingMode {
    MODE_SELECTOR = 0,
    MODE_BEACON_BANDIT = 1,
    MODE_WATCHERS_WATCH = 2,
    MODE_SKY_SWEEPER = 3
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
 * @brief Initialize Mode Manager queue and task
 */
void modeManagerInit();

/**
 * @brief FreeRTOS task to monitor and handle mode state transitions
 */
void ModeManagerTask(void *pvParameters);

/**
 * @brief Pause/resume BLE scanning globally
 */
void pauseBle(bool pause);

/**
 * @brief Pause/resume Wi-Fi scanning globally
 */
void pauseWifi(bool pause);

#endif // MODE_MANAGER_H
