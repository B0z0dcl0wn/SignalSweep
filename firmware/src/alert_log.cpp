// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "alert_log.h"
#include <LittleFS.h>
#include <Preferences.h>
#include <vector>

static const char* TAG = "ALERTLOG";

#define LOG_DIR    "/log"
#define LOG_FILE   "/log/alerts.bin"
#define NAMES_FILE "/log/names.txt"
#define BOOT_NVS_NS "sweep-st"

// Ring state, all derived at init — there is deliberately no persisted write
// pointer. A pointer would have to be written on every alert (NVS wear on a
// board meant to run unattended for months) and could still disagree with the
// data after a power cut, which this device suffers every time the engine
// stops. See findHead().
static uint32_t headIdx   = 0;      // next slot to write
static bool     wrapped   = false;  // ring has been round at least once
static uint16_t bootCount = 0;
static bool     fsReady   = false;

// The rule-name table, mirrored in RAM so a write never has to re-read the
// file. Capped at 255 because the record's index byte is one byte; a real
// signature list is ~20 rules, so this is not a limit anyone will meet.
static std::vector<String> ruleNames;

// ---------------------------------------------------------------------------
// Monotonic seconds.
//
// millis() rolls over at 49.7 days. A detector on a desk never sees that; one
// wired to a car battery does, and a rewound ordering key would break both the
// head search and the app's bookmark. Accumulating deltas in unsigned
// arithmetic rides the rollover as long as we are ticked more often than once
// per 49.7 days, which the 1 Hz task guarantees.
// ---------------------------------------------------------------------------
static uint32_t lastMs = 0;
static uint32_t secsNow = 0;
static uint32_t remMs = 0;

void alertLogTick() {
    uint32_t now = millis();
    uint32_t delta = now - lastMs;   // unsigned: correct across rollover
    lastMs = now;
    remMs += delta;
    if (remMs >= 1000) {
        secsNow += remMs / 1000;
        remMs   %= 1000;
    }
}

uint32_t alertLogSecs() { return secsNow; }
uint16_t alertLogBoot() { return bootCount; }

// ---------------------------------------------------------------------------
// Record serialisation. Explicit little-endian byte order, not a struct cast:
// this is the wire contract with app.js and must be identical on both
// toolchains (S3 Arduino core 2.x, C5 core 3.x).
// ---------------------------------------------------------------------------
static void packRec(uint8_t* b, uint16_t boot, uint32_t secs,
                    const uint8_t mac[6], uint8_t cat, uint8_t rule, int8_t rssi) {
    b[0] = (uint8_t)(boot & 0xFF);
    b[1] = (uint8_t)(boot >> 8);
    b[2] = (uint8_t)(secs & 0xFF);
    b[3] = (uint8_t)((secs >> 8) & 0xFF);
    b[4] = (uint8_t)((secs >> 16) & 0xFF);
    b[5] = (uint8_t)((secs >> 24) & 0xFF);
    memcpy(b + 6, mac, 6);
    b[12] = cat;
    b[13] = rule;
    b[14] = (uint8_t)rssi;
    b[15] = 0;
}

static inline uint16_t recBoot(const uint8_t* b) {
    return (uint16_t)b[0] | ((uint16_t)b[1] << 8);
}
static inline uint32_t recSecs(const uint8_t* b) {
    return (uint32_t)b[2] | ((uint32_t)b[3] << 8) |
           ((uint32_t)b[4] << 16) | ((uint32_t)b[5] << 24);
}

// Is a's key strictly newer than b's? (boot, secs) lexicographic.
static inline bool keyNewer(uint16_t aBoot, uint32_t aSecs, uint16_t bBoot, uint32_t bSecs) {
    if (aBoot != bBoot) return aBoot > bBoot;
    return aSecs > bSecs;
}
static inline bool keyOlder(uint16_t aBoot, uint32_t aSecs, uint16_t bBoot, uint32_t bSecs) {
    if (aBoot != bBoot) return aBoot < bBoot;
    return aSecs < bSecs;
}

static bool readRec(File& f, uint32_t idx, uint8_t* out) {
    if (!f.seek(idx * ALERT_LOG_REC_SIZE)) return false;
    return f.read(out, ALERT_LOG_REC_SIZE) == ALERT_LOG_REC_SIZE;
}

// ---------------------------------------------------------------------------
// Find the write head with no stored pointer.
//
// Records are appended in key order, so a full ring is a rotated sorted array
// and the head is its minimum. Classic rotated-array minimum search, ~17 reads
// for 100k records.
//
// ponytail: the equal-keys case (two alerts in the same second) degrades the
// search to a linear walk backwards, which is bounded by how many alerts can
// share one second — a handful. Not worth a second algorithm.
// ---------------------------------------------------------------------------
static void findHead(File& f, uint32_t nRecs) {
    uint8_t lo_[ALERT_LOG_REC_SIZE], hi_[ALERT_LOG_REC_SIZE], mid_[ALERT_LOG_REC_SIZE];
    uint32_t lo = 0, hi = nRecs - 1;

    if (!readRec(f, lo, lo_) || !readRec(f, hi, hi_)) { headIdx = 0; return; }
    // Not rotated: oldest is already at slot 0, so the next write is slot 0.
    if (!keyNewer(recBoot(lo_), recSecs(lo_), recBoot(hi_), recSecs(hi_))) {
        headIdx = 0;
        return;
    }
    while (lo < hi) {
        uint32_t mid = lo + (hi - lo) / 2;
        if (!readRec(f, mid, mid_) || !readRec(f, hi, hi_)) break;
        uint16_t mB = recBoot(mid_), hB = recBoot(hi_);
        uint32_t mS = recSecs(mid_), hS = recSecs(hi_);
        if (keyNewer(mB, mS, hB, hS))      lo = mid + 1;
        else if (keyOlder(mB, mS, hB, hS)) hi = mid;
        else                               hi--;   // equal keys: shrink by one
    }
    headIdx = lo;
}

// ---------------------------------------------------------------------------

static void loadNames() {
    ruleNames.clear();
    if (!LittleFS.exists(NAMES_FILE)) return;
    File f = LittleFS.open(NAMES_FILE, "r");
    if (!f) return;
    while (f.available() && ruleNames.size() < ALERT_LOG_RULE_NONE) {
        String line = f.readStringUntil('\n');
        line.trim();
        if (line.length() > 0) ruleNames.push_back(line);
    }
    f.close();
}

void alertLogInit() {
    // Boot counter: one NVS write per boot, never per alert. It is what makes
    // the ordering key monotonic ACROSS power cycles, which is what lets the
    // head be derived instead of stored.
    Preferences prefs;
    if (prefs.begin(BOOT_NVS_NS, false)) {
        bootCount = prefs.getUShort("logboot", 0) + 1;
        prefs.putUShort("logboot", bootCount);
        prefs.end();
    }
    lastMs = millis();

    if (!LittleFS.exists(LOG_DIR)) LittleFS.mkdir(LOG_DIR);
    loadNames();

    File f = LittleFS.open(LOG_FILE, "r");
    if (!f) {
        headIdx = 0;
        wrapped = false;
        fsReady = true;
        ESP_LOGI(TAG, "No log yet (boot %u)", (unsigned)bootCount);
        return;
    }
    uint32_t nRecs = f.size() / ALERT_LOG_REC_SIZE;
    if (nRecs >= ALERT_LOG_MAX_RECS) {
        wrapped = true;
        findHead(f, ALERT_LOG_MAX_RECS);
    } else {
        wrapped = false;
        headIdx = nRecs;
    }
    f.close();
    fsReady = true;
    ESP_LOGI(TAG, "Log boot %u: %u records, head %u, wrapped %d",
             (unsigned)bootCount, (unsigned)alertLogCount(),
             (unsigned)headIdx, (int)wrapped);
}

uint32_t alertLogCount() {
    return wrapped ? ALERT_LOG_MAX_RECS : headIdx;
}

bool alertLogWrapped() { return wrapped; }

String alertLogNames() {
    String out;
    for (size_t i = 0; i < ruleNames.size(); i++) {
        out += ruleNames[i];
        out += '\n';
    }
    return out;
}

// Index for a rule name, appending it to the table on first sight.
static uint8_t ruleIndex(const char* rule) {
    if (rule == NULL || rule[0] == '\0') return ALERT_LOG_RULE_NONE;
    for (size_t i = 0; i < ruleNames.size(); i++) {
        if (ruleNames[i].equals(rule)) return (uint8_t)i;
    }
    if (ruleNames.size() >= ALERT_LOG_RULE_NONE) return ALERT_LOG_RULE_NONE;
    String name(rule);
    name.replace('\n', ' ');   // one name per line is the whole format
    name.replace('\r', ' ');
    File f = LittleFS.open(NAMES_FILE, "a");
    if (!f) return ALERT_LOG_RULE_NONE;
    f.print(name);
    f.print('\n');
    f.close();
    ruleNames.push_back(name);
    return (uint8_t)(ruleNames.size() - 1);
}

void alertLogWrite(const uint8_t mac[6], uint8_t cat, const char* rule, int8_t rssi) {
    if (!fsReady) return;

    uint8_t idx = ruleIndex(rule);
    uint8_t rec[ALERT_LOG_REC_SIZE];
    packRec(rec, bootCount, secsNow, mac, cat, idx, rssi);

    // "r+" to overwrite in place once wrapped, "a" to grow. LittleFS is
    // power-safe per operation; the worst a cut costs is this one record.
    File f;
    if (headIdx < ALERT_LOG_MAX_RECS && !wrapped) {
        f = LittleFS.open(LOG_FILE, "a");
        if (!f) return;
        f.write(rec, ALERT_LOG_REC_SIZE);
    } else {
        f = LittleFS.open(LOG_FILE, "r+");
        if (!f) return;
        if (!f.seek(headIdx * ALERT_LOG_REC_SIZE)) { f.close(); return; }
        f.write(rec, ALERT_LOG_REC_SIZE);
    }
    f.close();

    headIdx++;
    if (headIdx >= ALERT_LOG_MAX_RECS) {
        headIdx = 0;
        wrapped = true;   // from here on the oldest record is overwritten first
    }
}

size_t alertLogRead(uint16_t fromBoot, uint32_t fromSecs, size_t skip,
                    uint8_t* out, size_t maxRecs, bool* outMore) {
    if (outMore) *outMore = false;
    if (!fsReady || out == NULL || maxRecs == 0) return 0;
    uint32_t total = alertLogCount();
    if (total == 0) return 0;

    File f = LittleFS.open(LOG_FILE, "r");
    if (!f) return 0;

    // Oldest first. Unwrapped the oldest is slot 0; wrapped it is the head,
    // because the head is exactly where the next overwrite lands.
    uint32_t start = wrapped ? headIdx : 0;
    size_t written = 0;
    size_t seen = 0;
    uint8_t rec[ALERT_LOG_REC_SIZE];
    for (uint32_t n = 0; n < total; n++) {
        uint32_t idx = (start + n) % ALERT_LOG_MAX_RECS;
        if (!readRec(f, idx, rec)) break;
        uint16_t b = recBoot(rec);
        uint32_t s = recSecs(rec);
        if (keyOlder(b, s, fromBoot, fromSecs)) continue;
        if (seen++ < skip) continue;
        if (written >= maxRecs) { if (outMore) *outMore = true; break; }
        memcpy(out + written * ALERT_LOG_REC_SIZE, rec, ALERT_LOG_REC_SIZE);
        written++;
    }
    f.close();
    return written;
}

void alertLogClear() {
    LittleFS.remove(LOG_FILE);
    LittleFS.remove(NAMES_FILE);
    ruleNames.clear();
    headIdx = 0;
    wrapped = false;
    ESP_LOGI(TAG, "Log cleared");
}

bool alertLogParseMac(const char* mac, uint8_t out[6]) {
    if (mac == NULL) return false;
    int n = 0;
    int hi = -1;
    for (const char* p = mac; *p && n < 6; p++) {
        char c = *p;
        int v;
        if      (c >= '0' && c <= '9') v = c - '0';
        else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
        else continue;                       // skip ':' / '-' / anything else
        if (hi < 0) { hi = v; }
        else        { out[n++] = (uint8_t)((hi << 4) | v); hi = -1; }
    }
    return n == 6 && hi < 0;
}
