// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef HARDWARE_MANAGER_H
#define HARDWARE_MANAGER_H

#include <Arduino.h>
#include "mode_manager.h"

#if CONFIG_IDF_TARGET_ESP32C5
// XIAO ESP32-C5: the same D1/D2 pads as the S3 harness, different GPIOs
// (variants/XIAO_ESP32C5/pins_arduino.h: D1 = GPIO0, D2 = GPIO25).
#define NEOPIXEL_PIN D1
#define NEOPIXEL_COUNT 8 // External 8-LED strip
#define BUZZER_PIN   D2
// Single core: xTaskCreatePinnedToCore(..., 1) asserts at boot.
#define SWEEP_TASK_CORE tskNO_AFFINITY
#else
// Hardware Pin Definitions for XIAO ESP32-S3
#define NEOPIXEL_PIN 2   // D1 pad (GPIO2)
#define NEOPIXEL_COUNT 8 // External 8-LED strip
#define BUZZER_PIN   3   // D2 pad (GPIO3)
#define SWEEP_TASK_CORE 1
#endif

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

// How much of the LED bar may light. Applied as the last step of every frame,
// so every animation, the hunt meter and the heartbeat obey it. Persisted.
enum LedMode : uint8_t { LED_OFF = 0, LED_ONE = 1, LED_DIM = 2, LED_FULL = 3 };

/** @brief Set the LED mode (clamped to LED_FULL) and persist it. */
void setLedMode(uint8_t mode);

/** @brief Current LED mode; no mutex, reported by CMD:CFG and the 1 Hz push. */
uint8_t getLedMode();

// A named look + sound. Recolours the finished frame and scales buzzer pitch;
// animation shapes and jingle rhythms -- the alert ID -- never change. One LED
// mode ignores it (a single pixel has no shape, only colour). Persisted. This
// order is the wire contract with THEMES in app.js (selftest pins it).
enum ThemeId : uint8_t { THEME_CLASSIC = 0, THEME_NIGHT = 1, THEME_TERMINAL = 2, THEME_GLACIER = 3, THEME_PARTY = 4 };

/** @brief Set the theme (clamped to THEME_PARTY) and persist it. */
void setTheme(uint8_t theme);

/** @brief Current theme; no mutex, reported by CMD:CFG and the 1 Hz push. */
uint8_t getTheme();

// Easter-egg scenes: the bar as a flashlight / light show. Deliberately NOT a
// mode and NOT persisted -- it owns the frame while it is set, expires on its
// own, and a power cycle always comes back to the detector's own heartbeat.
// This order is the wire contract with data-egg in index.html (selftest pins it).
enum EggScene : uint8_t {
    EGG_OFF = 0,
    EGG_TORCH,     // full white, full brightness — the reason this exists
    EGG_LANTERN,   // warm white at normal brightness — a tent light, not a searchlight
    EGG_CAMPFIRE,  // warm flicker, lantern brightness
    EGG_SOS,       // white morse SOS on a loop — the one that could matter
    EGG_STROBE,    // white, 20 ms in every 100
    EGG_SCANNER,   // KITT/Cylon red sweep
    EGG_MATRIX,    // green rain falling down the bar
    EGG_RAINBOW    // full-brightness rotating rainbow
};
#define EGG_COUNT 9

/** @brief Set the easter-egg scene (clamped). Transient: never persisted. */
void setEggScene(uint8_t scene);

/** @brief Current easter-egg scene; no mutex, deliberately not in CMD:CFG. */
uint8_t getEggScene();

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
