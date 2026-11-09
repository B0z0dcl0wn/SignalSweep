// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
//
// Two Axon payload checks (signatures v23), isolated as pure functions so the
// host g++ build in firmware/test/ can prove them. NO ESP / Arduino headers:
// <stdint.h>/<stddef.h>/<string.h> only, so this compiles unchanged on the host
// and on both boards. The radio code (mode_watchers_watch.cpp) only pulls the
// bytes out of the advert and hands them here.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

// ---------------------------------------------------------------------------
// TASER company ID squatters.
//
// Cheap IDO / VeryFit smartwatches (IDW26, ID205, ID207...) send manufacturer
// data under TASER International's company ID 0x034D with their own address as
// the first six payload bytes, and advertise service 0x0AF0. Axon gear never
// repeats its address there. Ported from RF Sentinel's isTaserIdSquatter()
// (CIS-C0/RFSentinel 843c738, SignatureEngine.kt:195-229, GPL-3.0; the watch
// case is their DetectionTest.kt:56).
#define TASER_COMPANY_ID 0x034D
#define IDO_WATCH_SERVICE 0x0AF0

// The IDO model-name shape, ^ID[A-Z]?\d{2,4}[A-Z]?$ (case-sensitive, as
// upstream). The optional letters can never be digits, so a greedy scan is
// exact.
static inline bool idoWatchName(const char* name) {
    if (!name || name[0] != 'I' || name[1] != 'D') return false;
    const char* p = name + 2;
    if (*p >= 'A' && *p <= 'Z') p++;
    int digits = 0;
    while (*p >= '0' && *p <= '9') { p++; digits++; }
    if (digits < 2 || digits > 4) return false;
    if (*p >= 'A' && *p <= 'Z') p++;
    return *p == '\0';
}

// mfg: the raw manufacturer-data field, company ID first (little-endian), as
// NimBLE's getManufacturerData() returns it. addr: the advertiser's address in
// display order (the order it prints, F4:FD:16:...). Suppress the hit only
// when the payload repeats the address AND a watch tell is present: the
// address alone could in principle be a real device's payload.
static inline bool taserIdSquatter(const uint8_t* mfg, size_t mfgLen, const uint8_t addr[6],
                                   bool hasIdoService, const char* name) {
    if (!mfg || mfgLen < 2 + 6) return false;
    if ((uint16_t)(mfg[0] | (mfg[1] << 8)) != TASER_COMPANY_ID) return false;
    if (memcmp(mfg + 2, addr, 6) != 0) return false;
    return hasIdoService || idoWatchName(name);
}

// ---------------------------------------------------------------------------
// Axon Signal trigger (fe6c service data).
//
// fe6c is TASER International's member UUID. A bare UUID is just Axon's number
// and lists at 60. The Signal trigger layout carries an ASCII serial in the
// fe6c service data; that is what earns the beep. AxonCadabra replays one
// captured trigger byte for byte, serial "X87002FP4" (its MainActivity.kt:38-46,
// documented in KaraZajac/OVERWATCH, BSD-3: AxonSignatures.kt and
// HackerTargets.kt), so that one serial is the tool, not a police car, and is
// excluded explicitly. The serial test is OVERWATCH's asciiSerial(): a run of
// at least 6 uppercase letters / digits.
#define AXON_SERIAL_MIN_RUN 6
#define AXONCADABRA_SERIAL "X87002FP4"

enum AxonSignalKind { AXON_SIG_NONE = 0, AXON_SIG_SERIAL = 1, AXON_SIG_CADABRA = 2 };

static inline size_t axonLongestSerialRun(const uint8_t* d, size_t len) {
    size_t best = 0, run = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t c = d[i];
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
            if (++run > best) best = run;
        } else {
            run = 0;
        }
    }
    return best;
}

// d/len: the fe6c service-data payload (UUID stripped).
static inline AxonSignalKind axonSignalKind(const uint8_t* d, size_t len) {
    if (!d || len == 0) return AXON_SIG_NONE;
    const size_t n = sizeof(AXONCADABRA_SERIAL) - 1;
    for (size_t i = 0; i + n <= len; i++)
        if (memcmp(d + i, AXONCADABRA_SERIAL, n) == 0) return AXON_SIG_CADABRA;
    return axonLongestSerialRun(d, len) >= AXON_SERIAL_MIN_RUN ? AXON_SIG_SERIAL : AXON_SIG_NONE;
}
