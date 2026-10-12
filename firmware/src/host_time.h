// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef HOST_TIME_H
#define HOST_TIME_H

#include <Arduino.h>

// The board has no clock of its own: it knows the date only once a host has
// told it, and forgets at power off. The app sends {"time":N} on every connect
// and it overwrites the system clock, no comparison. The one exception is a
// clock that is plainly unset (outside 2026..2038), which must not stamp 1970
// onto the logs. The board keeps UTC only; it never sets TZ.
//
// The upper bound is 2038, not 2100: the S3 Arduino toolchain (newlib) builds
// with a 32-bit time_t, so settimeofday/gmtime_r wrap at 2^31 seconds
// (2038-01-19T03:14:07Z) regardless of what a uint32_t epoch can hold on the
// wire. Raise this only once the S3 toolchain moves to a 64-bit time_t.

#define HOST_EPOCH_MIN 1767225600UL   // 2026-01-01T00:00:00Z
#define HOST_EPOCH_MAX 2147483647UL   // 2038-01-19T03:14:07Z (32-bit time_t wrap)

/** @brief Host time push. Returns false (and changes nothing) if out of range. Small: runs on the NimBLE host task. */
bool hostTimeSet(uint32_t epoch);

/** @brief Current UTC epoch, or 0 if no host has set it this boot. */
uint32_t hostTimeNow();

#endif // HOST_TIME_H
