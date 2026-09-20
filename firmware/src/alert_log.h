// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef ALERT_LOG_H
#define ALERT_LOG_H

#include <Arduino.h>

// A record of what the buzzer actually said, on the board's own flash.
//
// Why the board and not the phone: the device is headless and unattended —
// wired into a car it runs whether or not a phone is present, and Android
// cannot auto-launch an app on a BLE GATT connection (that trick belongs to
// paired Bluetooth Classic devices like headphones), nor keep a backgrounded
// WebView alive without a foreground service and a permanent notification.
// A log on the board works with the phone dead, absent, or in another jacket.
//
// Deliberately NOT recorded: position. The app's whole opsec property is that
// it keeps no passive trail, and a log of where you were is exactly the
// sightStore that was removed. Times and MACs only.
//
// ---------------------------------------------------------------------------
// /log/alerts.bin — fixed 16-byte records, appended until full, then wrapped.
//
//   offset  size  field
//   0       2     boot   uint16 LE   NVS boot counter
//   2       4     secs   uint32 LE   seconds since boot
//   6       6     mac    uint8[6]
//   12      1     cat    uint8       AlertCategory
//   13      1     rule   uint8       line index into names.txt (255 = unknown)
//   14      1     rssi   int8
//   15      1     (pad)
//
// Records are serialised byte-by-byte rather than memcpy'd from a struct: the
// layout is the wire contract with app.js (app/selftest.js pins it), and it
// must not be at the mercy of compiler packing on two different toolchains.
//
// (boot, secs) is monotonic across the whole log, and that is the entire trick
// behind having no write pointer to corrupt. See alertLogInit().
//
// /log/names.txt — one rule name per line, appended the first time that rule
// fires. Records store the line index, so the log carries its own names and
// editing the signature list next month cannot mislabel last month's log.
// ---------------------------------------------------------------------------

#define ALERT_LOG_REC_SIZE   16
// Overridable so the gitignored `logtest` bench env can shrink the ring to a
// few dozen records and actually overrun it. Wrapping and the head search are
// the one part of this file whose bugs are silent and eat data, and they are
// unreachable in a normal run: at one alert per appearance a real board takes
// months to go round once.
#ifndef ALERT_LOG_MAX_RECS
#define ALERT_LOG_MAX_RECS   100000UL   // 1.6 MB of a ~1.99 MB partition
#endif
#define ALERT_LOG_CAP_BYTES  (ALERT_LOG_MAX_RECS * ALERT_LOG_REC_SIZE)
#define ALERT_LOG_RULE_NONE  255

/**
 * @brief Mount-check, bump the boot counter, and locate the ring's write head.
 * Call once from setup(), after LittleFS.begin().
 */
void alertLogInit();

/**
 * @brief Advance the monotonic second counter. Call ~1 Hz from a task.
 * Keeps its own accumulator so millis() rolling over at 49.7 days does not
 * rewind the log's ordering key on a board wired to a car battery.
 */
void alertLogTick();

/**
 * @brief Append one alert. Blocks on flash for a few ms — call from a task,
 * NEVER from a radio callback.
 * @param mac   6 raw bytes
 * @param cat   AlertCategory
 * @param rule  matched rule name, may be empty
 * @param rssi  dBm
 */
void alertLogWrite(const uint8_t mac[6], uint8_t cat, const char* rule, int8_t rssi);

/**
 * @brief Read up to maxRecs records with a key at or after (fromBoot, fromSecs),
 * oldest first. Pass fromBoot 0 / fromSecs 0 for everything held.
 * @param skip     discard this many matches first -- exact paging, so the app
 *                 never has to de-duplicate several alerts sharing one second
 *                 the way advancing a timestamp cursor would force it to
 * @param out      caller buffer, at least maxRecs * ALERT_LOG_REC_SIZE bytes
 * @param outMore  set true if matches remained beyond maxRecs
 * @return number of records written to out
 */
size_t alertLogRead(uint16_t fromBoot, uint32_t fromSecs, size_t skip,
                    uint8_t* out, size_t maxRecs, bool* outMore);

/** @brief Records currently held (<= ALERT_LOG_MAX_RECS). */
uint32_t alertLogCount();

/** @brief True once the ring has wrapped and is overwriting its oldest records. */
bool alertLogWrapped();

/** @brief This boot's counter value, so the app can bookmark "from now". */
uint16_t alertLogBoot();

/** @brief Seconds since boot on the log's own monotonic clock. */
uint32_t alertLogSecs();

/** @brief The rule-name table, newline separated, for the app to join against. */
String alertLogNames();

/** @brief Erase the log and its name table. */
void alertLogClear();

/**
 * @brief Parse "aa:bb:cc:dd:ee:ff" into 6 bytes. Returns false if malformed.
 */
bool alertLogParseMac(const char* mac, uint8_t out[6]);

#endif // ALERT_LOG_H
