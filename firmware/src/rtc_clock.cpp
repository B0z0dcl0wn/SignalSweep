// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "rtc_clock.h"
#include "alert_log.h"
#include <Wire.h>
#include <sys/time.h>
#include <time.h>

#define DS3231_ADDR   0x68
#define DS3231_TIME   0x00   // 7 BCD registers: sec min hour dow date month year
#define DS3231_STATUS 0x0F   // bit 7 = OSF, oscillator stopped (coin cell died)

static uint8_t state = RTC_ABSENT;
static bool timeKnown = false;

static uint8_t toBcd(int v)       { return (uint8_t)(((v / 10) << 4) | (v % 10)); }
static int     fromBcd(uint8_t v) { return (v >> 4) * 10 + (v & 0x0F); }

static bool readRegs(uint8_t reg, uint8_t* out, int n) {
    Wire.beginTransmission(DS3231_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)DS3231_ADDR, n) != n) return false;
    for (int i = 0; i < n; i++) out[i] = Wire.read();
    return true;
}

static bool writeRegs(uint8_t reg, const uint8_t* in, int n) {
    Wire.beginTransmission(DS3231_ADDR);
    Wire.write(reg);
    Wire.write(in, n);
    return Wire.endTransmission() == 0;
}

static void setSystemClock(uint32_t epoch) {
    struct timeval tv = { (time_t)epoch, 0 };
    settimeofday(&tv, nullptr);
    timeKnown = true;
    alertLogAnchorSoon();
}

void rtcInit() {
    Wire.begin();
    Wire.beginTransmission(DS3231_ADDR);
    if (Wire.endTransmission() != 0) { state = RTC_ABSENT; return; }

    uint8_t st = 0;
    uint8_t r[7];
    if (!readRegs(DS3231_STATUS, &st, 1) || !readRegs(DS3231_TIME, r, 7)) {
        state = RTC_ABSENT;
        return;
    }
    if (st & 0x80) { state = RTC_LOST; return; }

    struct tm t = {};
    t.tm_sec  = fromBcd(r[0] & 0x7F);
    t.tm_min  = fromBcd(r[1] & 0x7F);
    t.tm_hour = fromBcd(r[2] & 0x3F);          // we always write 24 h mode
    t.tm_mday = fromBcd(r[4] & 0x3F);
    t.tm_mon  = fromBcd(r[5] & 0x1F) - 1;
    t.tm_year = 100 + fromBcd(r[6]);           // 20yy; century bit ignored (2100 is out of range)
    // ponytail: mktime() is UTC only because the firmware never sets TZ. If
    // anything ever calls setenv("TZ"), switch this to a timegm equivalent.
    time_t e = mktime(&t);
    if ((uint32_t)e < RTC_EPOCH_MIN || (uint32_t)e >= RTC_EPOCH_MAX) { state = RTC_LOST; return; }
    state = RTC_OK;
    setSystemClock((uint32_t)e);
}

bool rtcSetEpoch(uint32_t epoch) {
    if (epoch < RTC_EPOCH_MIN || epoch >= RTC_EPOCH_MAX) return false;
    setSystemClock(epoch);
    if (state == RTC_ABSENT) return true;

    // ponytail: aging-offset trim not exposed; the DS3231 is ~1 min/yr and every
    // connect re-syncs. Add a knob only if a soak shows drift that matters.
    time_t e = (time_t)epoch;
    struct tm t;
    gmtime_r(&e, &t);
    uint8_t r[7] = { toBcd(t.tm_sec), toBcd(t.tm_min), toBcd(t.tm_hour),
                     (uint8_t)(t.tm_wday + 1), toBcd(t.tm_mday),
                     toBcd(t.tm_mon + 1), toBcd(t.tm_year - 100) };
    uint8_t st = 0;
    if (writeRegs(DS3231_TIME, r, 7) && readRegs(DS3231_STATUS, &st, 1)) {
        st &= 0x7F;                            // clear OSF: the time is good again
        if (writeRegs(DS3231_STATUS, &st, 1)) state = RTC_OK;
    }
    return true;
}

uint8_t rtcState() { return state; }

uint32_t rtcNow() { return timeKnown ? (uint32_t)time(nullptr) : 0; }
