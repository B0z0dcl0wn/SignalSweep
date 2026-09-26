// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef SD_LOG_H
#define SD_LOG_H

#include <Arduino.h>

// The card copy of the alert log: the same events as the flash log (what the
// buzzer sounded), with the detail a 16-byte record cannot hold. One CSV per
// boot, /SIGSWEEP/LOGnnnnn.CSV. NO position column, ever -- not the user's,
// not a drone's or its operator's (a drone within a kilometre is your position).
//
// utc is filled when the board knows the time at write; otherwise blank, and a
// "#anchor,<epoch at secs 0>" line appended when the time arrives dates it.

#define SD_LOG_HEADER "boot,secs,utc,mac,category,rule,name,ssid,channel,role,vendor_id,confidence,rssi\n"

struct SdLogFields {
    uint32_t secs;       // alertLogSecs() when written
    uint8_t  mac[6];
    uint8_t  cat;        // AlertCategory
    int8_t   rssi;
    String   rule;
    String   name;       // BLE device name
    String   ssid;       // Wi-Fi SSID
    uint8_t  ch;         // Wi-Fi channel, 0 = none
    uint8_t  role;       // 0 none, 1 client, 2 ap (WatcherTargetInfo::wifiRole)
    int32_t  company;    // BLE company ID, -1 = none
    int      confidence; // 0-100
};

String sdLogFileName(uint16_t boot);
String sdLogCsvLine(uint16_t boot, const SdLogFields& f, uint32_t utcEpoch);
/** @brief Append one line to this boot's file (header on first write). Card only; call off the radio callbacks and outside watchersMutex. */
void sdLogWrite(const SdLogFields& f);
/** @brief ~1 Hz: append "#anchor" when this boot's anchor changes and the file exists. */
void sdLogTick();

#endif // SD_LOG_H
