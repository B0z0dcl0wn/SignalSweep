// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef SD_STORE_H
#define SD_STORE_H

#include <Arduino.h>

// Optional microSD card (bare 3.3 V reader on SPI: CS D3, SCK D8, MISO D9,
// MOSI D10). Probed like every other accessory: absent means SD_NONE and
// nothing else changes. Everything lives in /SIGSWEEP/ under 8.3 upper-case
// names -- a long name silently failed on the first card we tried.
//
// Threading: every call takes one recursive mutex, so the capture drain task,
// the detector's 1 Hz task and loop() can share the card. NEVER call from the
// NimBLE host task (processIncomingCommand) or a radio callback: card I/O is
// tens of ms and the host task's stack is small.
//
// A failed write marks the card SD_ERROR (or SD_FULL), unmounts it, and every
// later call returns false until sdProbe() succeeds again. No retry loop, no
// formatting, no deleting on its own.

enum SdState : uint8_t { SD_NONE = 0, SD_OK = 1, SD_ERROR = 2, SD_FULL = 3 };

/** @brief (Re)mount the card and create /SIGSWEEP. True if usable. */
bool sdProbe();
uint8_t sdState();
/** @brief Free space in MB, cached at the last probe or write failure. */
uint32_t sdFreeMB();

/** @brief 8.3 upper-case A-Z0-9 only, e.g. "LOG00031.CSV". No paths. */
bool sdValidName(const char* name);

/** @brief Open for append, write, close. The line is on the card when this returns true. */
bool sdAppend(const char* name, const uint8_t* data, size_t len);
bool sdExists(const char* name);

struct SdEntry { char name[13]; uint32_t size; };
/** @brief Regular files in /SIGSWEEP with valid names, up to max. */
size_t sdList(SdEntry* out, size_t max);

/** @brief Read up to n bytes at off. Returns bytes read (0 at EOF), -1 if missing/invalid. */
int32_t sdRead(const char* name, uint32_t off, uint8_t* buf, size_t n, uint32_t* sizeOut);
bool sdRemove(const char* name);

/** @brief First CAPnnnnn.SSC that does not exist yet. */
bool sdNextCaptureName(char out[13]);

/** @brief One long-lived write stream (captures). Only one open at a time. */
bool sdStreamOpen(const char* name);
bool sdStreamWrite(const uint8_t* data, size_t len);
void sdStreamClose();

#endif // SD_STORE_H
