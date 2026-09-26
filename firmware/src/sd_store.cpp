// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "sd_store.h"
#include <SPI.h>
#include <SD.h>

#define SD_DIR "/SIGSWEEP"

static SemaphoreHandle_t sdMutex = NULL;
static uint8_t  state   = SD_NONE;
static uint32_t freeMB  = 0;
static File     stream;
#ifdef SD_FAKE_LIMIT_BYTES
static uint32_t fakeWritten = 0;   // bench only: simulate a full card
#endif

struct SdLock {
    SdLock() {
        if (sdMutex == NULL) sdMutex = xSemaphoreCreateRecursiveMutex();
        xSemaphoreTakeRecursive(sdMutex, portMAX_DELAY);
    }
    ~SdLock() { xSemaphoreGiveRecursive(sdMutex); }
};

static void pathOf(const char* name, char out[32]) {
    snprintf(out, 32, SD_DIR "/%s", name);
}

static void refreshFree() {
    uint64_t total = SD.totalBytes(), used = SD.usedBytes();
    freeMB = total > used ? (uint32_t)((total - used) >> 20) : 0;
}

// Give up on the card until the next successful probe.
static void fail() {
    if (stream) stream.close();
    refreshFree();
    state = (freeMB == 0) ? SD_FULL : SD_ERROR;
    SD.end();
}

bool sdProbe() {
    SdLock l;
    if (stream) stream.close();
    SD.end();
    SPI.end();
    SPI.begin(D8, D9, D10, D3);   // SCK, MISO, MOSI, SS
    if (!SD.begin(D3, SPI, 4000000)) { state = SD_NONE; freeMB = 0; return false; }
    if (!SD.exists(SD_DIR) && !SD.mkdir(SD_DIR)) { state = SD_ERROR; SD.end(); return false; }
#ifdef SD_FAKE_LIMIT_BYTES
    fakeWritten = 0;
#endif
    refreshFree();
    state = SD_OK;
    return true;
}

uint8_t sdState() { return state; }
uint32_t sdFreeMB() { return freeMB; }

bool sdValidName(const char* name) {
    if (name == NULL) return false;
    int base = 0, ext = -1;
    for (const char* p = name; *p; p++) {
        char c = *p;
        if (c == '.') { if (ext >= 0 || base == 0) return false; ext = 0; continue; }
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return false;
        if (ext >= 0) { if (++ext > 3) return false; }
        else if (++base > 8) return false;
    }
    return base >= 1 && ext >= 1;
}

static bool writeGuard(size_t len) {
#ifdef SD_FAKE_LIMIT_BYTES
    if (fakeWritten + len > SD_FAKE_LIMIT_BYTES) { freeMB = 0; if (stream) stream.close(); state = SD_FULL; SD.end(); return false; }
    fakeWritten += len;
#endif
    return true;
}

bool sdAppend(const char* name, const uint8_t* data, size_t len) {
    SdLock l;
    if (state != SD_OK || !sdValidName(name)) return false;
    if (!writeGuard(len)) return false;
    char path[32];
    pathOf(name, path);
    File f = SD.open(path, FILE_APPEND);
    if (!f) { fail(); return false; }
    size_t w = f.write(data, len);
    f.close();
    if (w != len) { fail(); return false; }
    return true;
}

bool sdExists(const char* name) {
    SdLock l;
    if (state != SD_OK || !sdValidName(name)) return false;
    char path[32];
    pathOf(name, path);
    return SD.exists(path);
}

size_t sdList(SdEntry* out, size_t max) {
    SdLock l;
    if (state != SD_OK) return 0;
    File dir = SD.open(SD_DIR);
    if (!dir) return 0;
    size_t n = 0;
    for (File e = dir.openNextFile(); e && n < max; e = dir.openNextFile()) {
        if (e.isDirectory()) continue;
        const char* full = e.name();
        const char* base = strrchr(full, '/');
        base = base ? base + 1 : full;
        if (!sdValidName(base)) continue;
        strncpy(out[n].name, base, 12);
        out[n].name[12] = 0;
        out[n].size = (uint32_t)e.size();
        n++;
    }
    return n;
}

int32_t sdRead(const char* name, uint32_t off, uint8_t* buf, size_t n, uint32_t* sizeOut) {
    SdLock l;
    if (state != SD_OK || !sdValidName(name)) return -1;
    char path[32];
    pathOf(name, path);
    File f = SD.open(path, FILE_READ);
    if (!f) return -1;
    uint32_t size = (uint32_t)f.size();
    if (sizeOut) *sizeOut = size;
    int32_t got = 0;
    if (off < size && f.seek(off)) got = (int32_t)f.read(buf, n);
    f.close();
    return got;
}

bool sdRemove(const char* name) {
    SdLock l;
    if (state != SD_OK || !sdValidName(name)) return false;
    char path[32];
    pathOf(name, path);
    return SD.remove(path);
}

bool sdNextCaptureName(char out[13]) {
    SdLock l;
    if (state != SD_OK) return false;
    char path[32];
    for (uint32_t i = 1; i <= 99999; i++) {
        snprintf(out, 13, "CAP%05u.SSC", (unsigned)i);
        pathOf(out, path);
        if (!SD.exists(path)) return true;
    }
    return false;
}

bool sdStreamOpen(const char* name) {
    SdLock l;
    if (state != SD_OK || !sdValidName(name) || stream) return false;
    char path[32];
    pathOf(name, path);
    stream = SD.open(path, FILE_WRITE);
    if (!stream) { fail(); return false; }
    return true;
}

bool sdStreamWrite(const uint8_t* data, size_t len) {
    SdLock l;
    if (state != SD_OK || !stream) return false;
    if (!writeGuard(len)) return false;
    if (stream.write(data, len) != len) { fail(); return false; }
    return true;
}

void sdStreamClose() {
    SdLock l;
    if (stream) stream.close();
}
