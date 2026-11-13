// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
//
// Lights + brightness rules, isolated as pure functions so a host g++ build
// (firmware/test/) can prove the wire mapping, the legacy report, the Night Ops
// cap and the NVS migration. NO ESP / Arduino headers here: <stdint.h> only, so
// it compiles unchanged on the host and on both boards. All state is
// caller-owned (hardware_manager.cpp keeps the volatile bytes).
#pragma once
#include <stdint.h>

// How much of the LED bar may light. Applied as the last step of every frame,
// so every animation, the hunt meter and the heartbeat obey it. Persisted.
// Stored as Off / One / Bar (LED_FULL); LED_DIM is a legacy wire value only --
// {"led":2} means Bar + Low brightness, and the reported `led` is 2 for Bar at
// Low so old apps still paint Dim. LED_BAR_KEEP is the new app's Bar, which
// keeps the current brightness.
enum LedMode : uint8_t { LED_OFF = 0, LED_ONE = 1, LED_DIM = 2, LED_FULL = 3, LED_BAR_KEEP = 4 };

// Bar brightness, 0 Low / 1 Med / 2 High, applied to every Lights option.
// Night Ops still caps it at Low, except under One. Persisted.
enum Brightness : uint8_t { BRI_LOW = 0, BRI_MED = 1, BRI_HIGH = 2 };

struct LedState { uint8_t led; uint8_t bri; };

static inline uint8_t briClamp(uint8_t bri) {
    return bri > BRI_HIGH ? BRI_HIGH : bri;
}

// {"led":N}. Old apps send 2 (Dim) and 3 (Full): both are Bar, and they carry
// a brightness. 4 is the new app's Bar, which leaves brightness alone. Off and
// One keep the brightness too. Anything above 4 is treated as 4.
static inline LedState ledApplyCommand(uint8_t mode, uint8_t bri) {
    if (mode > LED_BAR_KEEP) mode = LED_BAR_KEEP;
    if (mode == LED_DIM) bri = BRI_LOW;
    else if (mode == LED_FULL) bri = BRI_HIGH;
    LedState s;
    s.led = mode >= LED_DIM ? (uint8_t)LED_FULL : mode;
    s.bri = briClamp(bri);
    return s;
}

// {"bri":N}. Sets brightness only (clamped to High); Lights is untouched.
static inline LedState briApplyCommand(LedState cur, uint8_t bri) {
    cur.bri = briClamp(bri);
    return cur;
}

// Derived, never stored: old apps know only Off / One / Dim / Full, so Bar at
// Low reports as Dim and Bar at any other level as Full. One reports 1 whatever
// the brightness -- old apps have no way to show One + dim.
static inline uint8_t ledReported(uint8_t led, uint8_t bri) {
    if (led != LED_FULL) return led;
    return bri == BRI_LOW ? (uint8_t)LED_DIM : (uint8_t)LED_FULL;
}

// The brightness setting applies to every Lights option, One included.
// Night Ops is capped at Low: red light for dark-adapted eyes.
// One is exempt -- it's Classic-only, so Night Ops must not dim it.
// Returns the brightness index to render (the egg is the caller's business).
static inline uint8_t ledRenderBri(uint8_t led, uint8_t bri, bool nightOps) {
    if (nightOps && led != LED_ONE) return BRI_LOW;
    return briClamp(bri);
}

// Bar is stored as LED_FULL. A board saved before brightness was its own
// setting has no "bri" key: its Dim (2) loads as Bar + Low and its Full (3) as
// Bar + High, which is what each of them looked like.
static inline LedState ledLoadNvs(uint8_t storedLed, bool hasBri, uint8_t storedBri) {
    LedState s;
    s.bri = hasBri ? briClamp(storedBri)
                   : (storedLed == LED_DIM ? (uint8_t)BRI_LOW : (uint8_t)BRI_HIGH);
    s.led = storedLed >= LED_DIM ? (uint8_t)LED_FULL : storedLed;
    return s;
}
