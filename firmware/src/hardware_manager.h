// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef HARDWARE_MANAGER_H
#define HARDWARE_MANAGER_H

#include <Arduino.h>
#include "mode_manager.h"

// Hardware Pin Definitions for XIAO ESP32-S3
#define NEOPIXEL_PIN 2   // D1 pad (GPIO2)
#define NEOPIXEL_COUNT 8 // External 8-LED strip
#define BUZZER_PIN   3   // D2 pad (GPIO3)

/**
 * @brief Initialize NeoPixel and Buzzer hardware and start background FreeRTOS task
 */
void hardwareInit();

/**
 * @brief Update hardware manager state with current operating mode for status LED & jingles
 * @param mode The active OperatingMode
 */
void hardwareSetMode(OperatingMode mode);

/**
 * @brief Play mode transition jingle asynchronously
 * @param mode Target mode jingle to play
 */
void playModeJingle(OperatingMode mode);

/**
 * @brief Play a short chirp when a BLE client connects
 */
void playConnectionChirp();

/**
 * @brief Play a short chirp when a BLE client disconnects
 */
void playDisconnectionChirp();

/**
 * @brief Trigger a single Geiger counter audio/visual click based on target RSSI
 * @param rssi Current RSSI strength in dBm (-100 to -30)
 */
void updateGeigerRssi(int rssi);

/**
 * @brief Enable or disable target locked state for background Geiger counter clicks
 * @param locked true if target is locked, false to stop Geiger audio
 * @param initialRssi optional initial RSSI value
 */
void setGeigerTargetLock(bool locked, int initialRssi = -90);

/**
 * @brief Set global buzzer enabled / mute state
 * @param enabled true to enable buzzer, false to mute
 */
void setBuzzerEnabled(bool enabled);

/**
 * @brief Check if buzzer audio is enabled
 * @return true if enabled, false if muted
 */
bool isBuzzerEnabled();

/**
 * @brief Swap the idle blink to dim blue while the device is in receive-only.
 * The only visible sign that it has stopped advertising.
 */
void setRxOnlyIndicator(bool quiet);

/**
 * @brief Trigger a custom momentary NeoPixel flash asynchronously
 * @param r Red channel (0-255)
 * @param g Green channel (0-255)
 * @param b Blue channel (0-255)
 * @param durationMs Duration of flash in ms
 */
void triggerLedFlash(uint8_t r, uint8_t g, uint8_t b, uint32_t durationMs);

/**
 * @brief Trigger a distinct audio/visual alarm for new targets
 */
void triggerAlarm();

/**
 * @brief Trigger a softer visual/audio warning for possible targets
 */
void triggerWarning();

// The headless buzzer is the whole UI: a different pattern per device category
// is how you know what's near without looking (dash-mount / pocket). The phone
// spells it out in text; the ear learns these four "words".
enum AlertCategory {
    ALERT_ALPR = 0,   // Flock / ALPR / fixed camera — two long beeps
    ALERT_BODYCAM,    // Axon-style body cam        — long-short-short
    ALERT_DRONE,      // Remote-ID drone            — rising trill
    ALERT_TRACKER,    // AirTag-style tracker       — fast ticking
    ALERT_GENERIC     // matched, category unknown  — plain warning
};

/**
 * @brief Map a signature/detector category string to an AlertCategory.
 * Keyword-tolerant so signature `category` labels ("Flock Safety", "Axon Body
 * Cam", "Remote ID Drone", …) route to the right buzzer word without an exact
 * table. The one place category→sound is decided.
 */
AlertCategory alertCategoryFromName(const char* category);

/**
 * @brief Sound the buzzer pattern for a device category (headless identification).
 */
void triggerCategoryAlert(AlertCategory cat);

#endif // HARDWARE_MANAGER_H
