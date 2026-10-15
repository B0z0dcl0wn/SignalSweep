// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "sd_log.h"
#include "sd_store.h"
#include "alert_log.h"
#include "host_time.h"
#include <time.h>

// Same order as AlertCategory and read-log.py's CATS.
static const char* CAT_NAMES[] = {"ALPR/Camera", "Body cam", "Drone", "Tracker", "Other"};

static uint32_t anchorOnCard = 0;   // anchor last written into this boot's file
// This boot's CSV has been seen or created. Only sdLogWrite() makes it, so
// until it has there is nothing for sdLogTick() to anchor -- and no reason to
// ask the card every second.
static bool     logFileSeen  = false;
// This boot's file. NOT named by boot number: the NVS boot counter can be reset
// below the card's files (a factory reset, a reflash), and boots then appended
// to old files -- LOG00063 held Sep 26 and Oct 10. The first write takes the
// next free number; the CSV's boot column still says which boot.
static char     logName[13]  = "";

// Device-chosen text is data: quote when needed, double quotes, and turn line
// breaks into spaces so one alert is always one line.
static String csvField(const String& s) {
    String o;
    bool quote = false;
    for (size_t i = 0; i < s.length(); i++) {
        char c = s[i];
        if (c == '\n' || c == '\r') c = ' ';
        if (c == ',' || c == '"') quote = true;
        if (c == '"') o += '"';
        o += c;
    }
    return quote ? "\"" + o + "\"" : o;
}

String sdLogCsvLine(uint16_t boot, const SdLogFields& f, uint32_t utcEpoch) {
    char mac[18];
    snprintf(mac, sizeof(mac), "%02x:%02x:%02x:%02x:%02x:%02x",
             f.mac[0], f.mac[1], f.mac[2], f.mac[3], f.mac[4], f.mac[5]);
    char utc[24] = "";
    if (utcEpoch) {
        time_t t = (time_t)utcEpoch;
        struct tm tmv;
        gmtime_r(&t, &tmv);
        strftime(utc, sizeof(utc), "%Y-%m-%dT%H:%M:%SZ", &tmv);
    }
    String o;
    o.reserve(160);
    o += String(boot); o += ',';
    o += String(f.secs); o += ',';
    o += utc; o += ',';
    o += mac; o += ',';
    o += CAT_NAMES[f.cat < 5 ? f.cat : 4]; o += ',';
    o += csvField(f.rule); o += ',';
    o += csvField(f.name); o += ',';
    o += csvField(f.ssid); o += ',';
    if (f.ch) o += String(f.ch);
    o += ',';
    o += (f.role == 2 ? "ap" : f.role == 1 ? "client" : "");
    o += ',';
    if (f.company >= 0) o += String(f.company);
    o += ',';
    o += String(f.confidence); o += ',';
    o += String((int)f.rssi);
    o += '\n';
    return o;
}

static void writeAnchorLine(const char* name, uint32_t anchor) {
    char a[32];
    int n = snprintf(a, sizeof(a), "#anchor,%u\n", (unsigned)anchor);
    if (sdAppend(name, (const uint8_t*)a, n)) anchorOnCard = anchor;
}

void sdLogWrite(const SdLogFields& f) {
    if (sdState() != SD_OK) return;
    uint16_t boot = alertLogBoot();
    // Gone (first write, or the card was swapped): a fresh file, never an old one.
    if (!logName[0] || !sdExists(logName)) {
        if (!sdNextName("LOG", "CSV", logName)) { logName[0] = 0; return; }
        String name = logName;
        if (!sdAppend(name.c_str(), (const uint8_t*)SD_LOG_HEADER, strlen(SD_LOG_HEADER))) return;
        anchorOnCard = 0;
        uint32_t anchor = alertLogAnchorEpoch();
        if (anchor) writeAnchorLine(name.c_str(), anchor);
    }
    logFileSeen = true;
    String line = sdLogCsvLine(boot, f, hostTimeNow());
    sdAppend(logName, (const uint8_t*)line.c_str(), line.length());
}

void sdLogTick() {
    uint32_t anchor = alertLogAnchorEpoch();
    if (!logFileSeen || !anchor || anchor == anchorOnCard || sdState() != SD_OK) return;
    // Still checked: a card swapped since would otherwise get a headerless
    // file that starts with the anchor. Reached only when the anchor moves.
    if (sdExists(logName)) writeAnchorLine(logName, anchor);
}
