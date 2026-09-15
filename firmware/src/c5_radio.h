// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
//
// XIAO ESP32-C5 radio settings, measured on the bench and in field drives
// (docs/plans/2026-09-13-c5-capture-experiment.md). Shared by the detector's
// channel hopper and the packet capture so both hear the same way.
#pragma once
#include <Arduino.h>
#if CONFIG_IDF_TARGET_ESP32C5

// Wire and NVS contract ({"band":N}, sweep-st/band): keep app.js in step.
enum SweepBand : uint8_t { BAND_BOTH = 0, BAND_24 = 1, BAND_5 = 2 };

// 120 ms beat 250 ms on 2.4 GHz revisit with the same channel list (round 2, E vs B).
static const uint16_t C5_HOP_DWELL_MS = 120;

// 2.4 GHz 1-11, then the non-DFS 5 GHz channels. DFS channels cost every other
// channel listening time on a single hopping radio (rounds 1-2, A/F vs B).
static inline size_t c5BuildHop(uint8_t band, uint8_t* out, size_t max) {
    static const uint8_t ch24[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
    static const uint8_t ch5[] = {36, 40, 44, 48, 149, 153, 157, 161, 165};
    size_t n = 0;
    if (band != BAND_5)  for (uint8_t c : ch24) if (n < max) out[n++] = c;
    if (band != BAND_24) for (uint8_t c : ch5)  if (n < max) out[n++] = c;
    return n;
}

#endif
