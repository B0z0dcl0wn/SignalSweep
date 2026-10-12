// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "host_time.h"
#include "alert_log.h"
#include <sys/time.h>
#include <time.h>

static bool timeKnown = false;

bool hostTimeSet(uint32_t epoch) {
    if (epoch < HOST_EPOCH_MIN || epoch >= HOST_EPOCH_MAX) return false;
    struct timeval tv = { (time_t)epoch, 0 };
    settimeofday(&tv, nullptr);
    timeKnown = true;
    alertLogAnchorSoon();     // only sets a flag; the write happens on the 1 Hz tick
    return true;
}

uint32_t hostTimeNow() { return timeKnown ? (uint32_t)time(nullptr) : 0; }
