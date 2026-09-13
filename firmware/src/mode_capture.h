// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef MODE_CAPTURE_H
#define MODE_CAPTURE_H

#include <Arduino.h>

/**
 * @brief Start a stationary diagnostic packet capture for durationSecs (0 = run
 * until stopCapture()). Pauses the detector, logs every WiFi frame (all types)
 * and BLE advertisement to a base64 "CAP:" line stream over USB, and auto-stops
 * when the timer expires. See the record format in mode_capture.cpp.
 */
void startCapture(uint32_t durationSecs);

/** @brief Request an in-progress capture to stop early and resume the detector. */
void stopCapture();

/** @brief True while a capture is running. */
bool isCapturing();

/**
 * @brief Poll from loop(): completes the detector restart after a capture ends.
 * The restart must not run inside the capture task (which deletes itself), so
 * the task sets a flag and loop() acts on it.
 */
void captureTick();

#endif // MODE_CAPTURE_H
