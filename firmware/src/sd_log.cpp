// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "sd_log.h"
#include "sd_store.h"
#include "alert_log.h"
#include "rtc_clock.h"
#include <time.h>

// Same order as AlertCategory and read-log.py's CATS.
static const char* CAT_NAMES[] = {"ALPR/Camera", "Body cam", "Drone", "Tracker", "Other"};

static uint32_t anchorOnCard = 0;   // anchor last written into this boot's file

String sdLogFileName(uint16_t boot) {
    char n[13];
    snprintf(n, sizeof(n), "LOG%05u.CSV", (unsigned)boot);
    return String(n);
}

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
    String name = sdLogFileName(boot);
    if (!sdExists(name.c_str())) {
        if (!sdAppend(name.c_str(), (const uint8_t*)SD_LOG_HEADER, strlen(SD_LOG_HEADER))) return;
        anchorOnCard = 0;
        uint32_t anchor = alertLogAnchorEpoch();
        if (anchor) writeAnchorLine(name.c_str(), anchor);
    }
    String line = sdLogCsvLine(boot, f, rtcNow());
    sdAppend(name.c_str(), (const uint8_t*)line.c_str(), line.length());
}

void sdLogTick() {
    uint32_t anchor = alertLogAnchorEpoch();
    if (!anchor || anchor == anchorOnCard || sdState() != SD_OK) return;
    String name = sdLogFileName(alertLogBoot());
    if (sdExists(name.c_str())) writeAnchorLine(name.c_str(), anchor);
}
