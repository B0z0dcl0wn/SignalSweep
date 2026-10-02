// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
//
// Rate-based attack-detector decision logic, isolated as pure functions so a
// host g++ build (firmware/test/) can prove the sliding-window math the radio
// callbacks run verbatim. NO ESP / Arduino headers here: <stdint.h>/<string.h>
// only, so it compiles unchanged on the host and on both boards. All state is
// caller-owned (the firmware keeps one file-static instance of each; tests make
// their own), touched from ONE thread each -- no lock lives in here.
#pragma once
#include <stdint.h>
#include <string.h>

#define ATTACK_LRU_SLOTS          8
#define ATTACK_DISTINCT_CAP       16

#define ATTACK_DEAUTH_THRESHOLD   30       // frames per transmitter in the window (field soak 2026-09-28: legit APs hit 11-24)
#define ATTACK_WINDOW_MS_DEAUTH   5000u
#define ATTACK_DEAUTH_RING        64       // > 2*threshold: a broadcast burst (x2) fits; must exceed THRESHOLD or it can never fire
static_assert(ATTACK_DEAUTH_RING > ATTACK_DEAUTH_THRESHOLD, "deauth ring must hold more than THRESHOLD timestamps or the detector can never fire");

#define ATTACK_KARMA_THRESHOLD    4        // distinct SSIDs one BSSID answers
#define ATTACK_WINDOW_MS_KARMA    60000u

#define ATTACK_BLESPAM_THRESHOLD  8        // distinct random MACs sending 0x07/0x0F
#define ATTACK_WINDOW_MS_BLESPAM  5000u
// Adverts weaker than this do not count. A parking lot of AirPods at -90..-97
// tripped the rule on 2026-10-01 (12 real earbuds in one 5 s window); at -80
// the same capture peaks at 5. Tuning knob: fitted to that one capture.
#ifndef ATTACK_BLESPAM_MIN_RSSI          // -D overrides it for a bench build
#define ATTACK_BLESPAM_MIN_RSSI   (-80)
#endif

#define ATTACK_TITLE_DEAUTH   "Deauth burst"
#define ATTACK_TITLE_KARMA    "Karma AP"
#define ATTACK_TITLE_BLESPAM  "BLE popup spam"

// millis() wraps ~every 49 days; the board runs for months. Unsigned subtraction
// is correct across the wrap iff both are uint32_t: (uint32_t)(now - ts).
static inline int attackInWindow(uint32_t now, uint32_t ts, uint32_t windowMs) {
    return (uint32_t)(now - ts) <= windowMs;
}

static inline uint64_t attackMac48(const uint8_t m[6]) {
    return ((uint64_t)m[0] << 40) | ((uint64_t)m[1] << 32) | ((uint64_t)m[2] << 24) |
           ((uint64_t)m[3] << 16) | ((uint64_t)m[4] << 8) | (uint64_t)m[5];
}

static inline uint64_t attackHash(const uint8_t* p, int n) {  // FNV-1a 64
    uint64_t h = 1469598103934665603ULL;
    for (int i = 0; i < n; i++) { h ^= (uint8_t)p[i]; h *= 1099511628211ULL; }
    return h ? h : 1;   // 0 is reserved as "empty" elsewhere
}

// ---- Deauth: frames per transmitter, sliding window -----------------------
typedef struct {
    uint8_t  used;
    uint64_t key;                       // transmitter MAC48
    uint32_t ts[ATTACK_DEAUTH_RING];    // ring of recent frame timestamps
    uint8_t  head;                      // next write index
    uint8_t  fill;                      // entries used (<= RING)
    uint32_t lastSeen;
} DeauthSlot;
typedef struct { DeauthSlot slot[ATTACK_LRU_SLOTS]; } DeauthState;

static inline DeauthSlot* attackDeauthSlot(DeauthState* st, uint64_t key, uint32_t now) {
    for (int i = 0; i < ATTACK_LRU_SLOTS; i++)
        if (st->slot[i].used && st->slot[i].key == key) return &st->slot[i];
    // `now` is monotonic millis(), so (now - lastSeen) is the wrap-safe age --
    // same form as karmaNote's eviction below.
    int lru = 0;
    for (int i = 0; i < ATTACK_LRU_SLOTS; i++) {
        if (!st->slot[i].used) { lru = i; break; }
        if ((uint32_t)(now - st->slot[i].lastSeen) > (uint32_t)(now - st->slot[lru].lastSeen)) lru = i;
    }
    DeauthSlot* s = &st->slot[lru];
    memset(s, 0, sizeof(*s));
    s->used = 1; s->key = key;
    return s;
}

static inline uint32_t deauthNote(DeauthState* st, uint64_t tx, int isBroadcast, uint32_t now) {
    DeauthSlot* s = attackDeauthSlot(st, tx, now);
    int pushes = isBroadcast ? 2 : 1;   // a broadcast deauth hits every client at once
    for (int p = 0; p < pushes; p++) {
        s->ts[s->head] = now;
        s->head = (uint8_t)((s->head + 1) % ATTACK_DEAUTH_RING);
        if (s->fill < ATTACK_DEAUTH_RING) s->fill++;
    }
    s->lastSeen = now;
    uint32_t c = 0;
    for (int i = 0; i < s->fill; i++) if (attackInWindow(now, s->ts[i], ATTACK_WINDOW_MS_DEAUTH)) c++;
    return c;
}

// ---- Distinct sub-keys within a window (shared by karma + BLE spam) -------
typedef struct { uint8_t used; uint64_t key; uint32_t ts; } DistinctEntry;
typedef struct { DistinctEntry e[ATTACK_DISTINCT_CAP]; } DistinctSet;

static inline uint32_t attackDistinctNote(DistinctSet* s, uint64_t key, uint32_t now, uint32_t windowMs) {
    int slot = -1, oldest = 0;
    for (int i = 0; i < ATTACK_DISTINCT_CAP; i++) {
        if (s->e[i].used && !attackInWindow(now, s->e[i].ts, windowMs)) s->e[i].used = 0;  // expire
        if (s->e[i].used && s->e[i].key == key) { s->e[i].ts = now; slot = i; }
    }
    if (slot < 0) {   // not present: insert into an empty slot, else overwrite the oldest
        int empty = -1;
        for (int i = 0; i < ATTACK_DISTINCT_CAP; i++) {
            if (!s->e[i].used) { empty = i; break; }
            // Every still-used entry here is already in-window (expired above),
            // but `now` is monotonic millis(), so use the wrap-safe age form
            // rather than comparing raw `ts` values directly.
            if ((uint32_t)(now - s->e[i].ts) > (uint32_t)(now - s->e[oldest].ts)) oldest = i;
        }
        int put = (empty >= 0) ? empty : oldest;
        s->e[put].used = 1; s->e[put].key = key; s->e[put].ts = now;
    }
    uint32_t c = 0;
    for (int i = 0; i < ATTACK_DISTINCT_CAP; i++) if (s->e[i].used && attackInWindow(now, s->e[i].ts, windowMs)) c++;
    return c;
}

// ---- Karma: one BSSID answering probes for many distinct SSIDs ------------
typedef struct { uint8_t used; uint64_t bssid; uint32_t lastSeen; DistinctSet ssids; } KarmaSlot;
typedef struct { KarmaSlot slot[ATTACK_LRU_SLOTS]; } KarmaState;

static inline uint32_t karmaNote(KarmaState* st, uint64_t bssid, uint64_t ssidHash, uint32_t now) {
    int idx = -1, lru = 0;
    for (int i = 0; i < ATTACK_LRU_SLOTS; i++) if (st->slot[i].used && st->slot[i].bssid == bssid) { idx = i; break; }
    if (idx < 0) {
        for (int i = 0; i < ATTACK_LRU_SLOTS; i++) {
            if (!st->slot[i].used) { lru = i; break; }
            if ((uint32_t)(now - st->slot[i].lastSeen) > (uint32_t)(now - st->slot[lru].lastSeen)) lru = i;
        }
        idx = lru; memset(&st->slot[idx], 0, sizeof(st->slot[idx]));
        st->slot[idx].used = 1; st->slot[idx].bssid = bssid;
    }
    st->slot[idx].lastSeen = now;
    return attackDistinctNote(&st->slot[idx].ssids, ssidHash, now, ATTACK_WINDOW_MS_KARMA);
}

// ---- BLE popup spam: distinct random MACs sending 0x07/0x0F globally ------
typedef DistinctSet BleSpamState;
static inline uint32_t bleSpamNote(BleSpamState* st, uint64_t mac, int rssi, uint32_t now) {
    if (rssi < ATTACK_BLESPAM_MIN_RSSI) return 0;   // too far to be the thing popping up your phone
    return attackDistinctNote(st, mac, now, ATTACK_WINDOW_MS_BLESPAM);
}

// ---- Tag flood: fake trackers on throwaway addresses ------------------------
// A real tag keeps one address ~15 min and adverts every ~2 s. A spammer's
// address is heard a couple of times and never again. Evidence = an address
// quiet >= QUIET_MS with <= MAX_HITS adverts (or evicted from a full ring with
// <= MAX_HITS: a flood faster than the ring must still count). EVIDENCE pieces
// inside WINDOW_MS trips; HOLD_MS with no new evidence releases. Per type.
// Evidence is dated when the address went quiet (last + QUIET_MS), never when
// the lazy sweep noticed: fakes left in the ring after a flood are swept by the
// next advert of that type, maybe hours later, and dating them "now" re-tripped
// the gate on the first real tag. One address counts once per WINDOW_MS, or a
// weak real tag heard every ~40 s counts on every gap.
#define TAGFLOOD_TYPES      4          // Apple Find My, Google FMDN, Samsung, Tile
#define TAGFLOOD_ADDRS      32
#define TAGFLOOD_EVIDENCE   6
#define TAGFLOOD_MAX_HITS   3
#define TAGFLOOD_QUIET_MS   30000u
#define TAGFLOOD_WINDOW_MS  300000u
#define TAGFLOOD_HOLD_MS    300000u
#define TAGFLOOD_TITLE      "Tag flood"

typedef struct { uint8_t used; uint8_t hits; uint64_t key; uint32_t last; } TagFloodAddr;
typedef struct {
    TagFloodAddr a[TAGFLOOD_ADDRS];
    uint32_t ev[TAGFLOOD_EVIDENCE]; uint64_t evKey[TAGFLOOD_EVIDENCE]; uint8_t evN;
    uint8_t tripped; uint32_t lastEvidence; uint32_t total;
} TagFloodState;

// `stamp` <= now always (a sweep only fires once last + QUIET_MS has passed).
static inline void tagFloodEvidence(TagFloodState* st, uint64_t key, uint32_t stamp, uint32_t now) {
    int slot = st->evN;
    for (int i = 0; i < st->evN; i++) {
        if (st->evKey[i] == key && (uint32_t)(now - st->ev[i]) <= TAGFLOOD_WINDOW_MS) return;
        if (st->evN == TAGFLOOD_EVIDENCE && (slot == TAGFLOOD_EVIDENCE ||
            (uint32_t)(now - st->ev[i]) > (uint32_t)(now - st->ev[slot]))) slot = i;   // oldest
    }
    if (st->evN < TAGFLOOD_EVIDENCE) st->evN++;
    st->ev[slot] = stamp; st->evKey[slot] = key; st->total++;
    if (st->total == 1 || (uint32_t)(now - stamp) < (uint32_t)(now - st->lastEvidence)) st->lastEvidence = stamp;
    if (st->evN < TAGFLOOD_EVIDENCE) return;
    uint32_t newest = 0xFFFFFFFFu, oldest = 0;
    for (int i = 0; i < TAGFLOOD_EVIDENCE; i++) {
        uint32_t age = (uint32_t)(now - st->ev[i]);
        if (age < newest) newest = age;
        if (age > oldest) oldest = age;
    }
    if (oldest - newest <= TAGFLOOD_WINDOW_MS) st->tripped = 1;
}

static inline void tagFloodNote(TagFloodState* st, uint64_t key, uint32_t now) {
    int hit = -1, empty = -1, oldest = -1;
    for (int i = 0; i < TAGFLOOD_ADDRS; i++) {
        TagFloodAddr* e = &st->a[i];
        if (!e->used) { if (empty < 0) empty = i; continue; }
        if (e->key == key) { hit = i; continue; }
        if ((uint32_t)(now - e->last) >= TAGFLOOD_QUIET_MS) {
            if (e->hits <= TAGFLOOD_MAX_HITS) tagFloodEvidence(st, e->key, e->last + TAGFLOOD_QUIET_MS, now);
            e->used = 0; if (empty < 0) empty = i; continue;
        }
        if (oldest < 0 || (uint32_t)(now - e->last) > (uint32_t)(now - st->a[oldest].last)) oldest = i;
    }
    if (hit >= 0) { st->a[hit].last = now; if (st->a[hit].hits < 255) st->a[hit].hits++; return; }
    int put = empty;
    if (put < 0) { put = oldest; if (st->a[put].hits <= TAGFLOOD_MAX_HITS) tagFloodEvidence(st, st->a[put].key, now, now); }
    st->a[put].used = 1; st->a[put].hits = 1; st->a[put].key = key; st->a[put].last = now;
}

// ponytail: expiry is checked lazily, on the next advert of this type; a type
// silent for 49+ days mid-hold would read as fresh (millis wrap). Accepted.
static inline int tagFloodActive(TagFloodState* st, uint32_t now) {
    if (st->tripped && (uint32_t)(now - st->lastEvidence) >= TAGFLOOD_HOLD_MS) {
        st->tripped = 0; st->evN = 0; st->total = 0;
    }
    return st->tripped;
}
