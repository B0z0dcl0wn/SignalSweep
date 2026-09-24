// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef RTC_CLOCK_H
#define RTC_CLOCK_H

#include <Arduino.h>

// Optional DS3231 on I2C (D4 = SDA, D5 = SCL on both XIAO boards; Wire.begin()
// with no arguments resolves them from the variant). Probed once at boot like
// every other accessory: absent means "time only from a host, until power off".
//
// The host is the authority: the app sends {"time":N} on every connect and it
// overwrites the system clock and the RTC, no comparison. The one exception is
// a clock that is plainly unset (outside 2026..2038), which must not stamp 1970
// over a good RTC. The board keeps UTC only; it never sets TZ.
//
// The upper bound is 2038, not 2100: the S3 Arduino toolchain (newlib) builds
// with a 32-bit time_t, so settimeofday/mktime/gmtime_r all wrap at
// 2^31 seconds (2038-01-19T03:14:07Z) regardless of what a uint32_t epoch can
// hold on the wire. Accepting a value past that would store something that
// reads back negative. Raise this only once the S3 toolchain moves to a
// 64-bit time_t.

#define RTC_EPOCH_MIN 1767225600UL   // 2026-01-01T00:00:00Z
#define RTC_EPOCH_MAX 2147483647UL   // 2038-01-19T03:14:07Z (32-bit time_t wrap)

enum RtcState : uint8_t { RTC_ABSENT = 0, RTC_OK = 1, RTC_LOST = 2 };

/** @brief Probe the DS3231 and seed the system clock from it. Call in setup() after alertLogInit(). */
void rtcInit();

/** @brief Host time push. Returns false (and changes nothing) if out of range. Small: runs on the NimBLE host task. */
bool rtcSetEpoch(uint32_t epoch);

/** @brief RTC_ABSENT, RTC_OK, or RTC_LOST (fitted, but its oscillator stopped and no host has set it since). */
uint8_t rtcState();

/** @brief Current UTC epoch, or 0 if neither a host nor the RTC has set it this boot. */
uint32_t rtcNow();

#endif // RTC_CLOCK_H
