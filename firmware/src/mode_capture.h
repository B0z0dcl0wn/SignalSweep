// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef MODE_CAPTURE_H
#define MODE_CAPTURE_H

#include <Arduino.h>

/**
 * @brief Ask for a capture; it starts on the next captureTick() (loop()), never
 * on the caller's stack -- the router runs on the NimBLE host task, and starting
 * a capture stops the detector, allocates PSRAM and spawns tasks.
 * @param toSd write the .sscap to the optional card instead of streaming over USB
 */
void requestCapture(uint32_t durationSecs, bool toSd);

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
