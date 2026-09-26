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
static char     streamName[13] = "";   // name of the file `stream` has open, "" if none
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

// Give up on the card until the next successful probe. FULL only if the card
// still answers with a real size and no room: a pulled card reads total 0, and
// calling that "full" sent people hunting for space on a card that was gone.
// Anything else is ERROR, and sd_free keeps the last value the card reported.
static void fail() {
    uint32_t lastKnown = freeMB;
    if (stream) stream.close();
    streamName[0] = 0;
    uint64_t total = SD.totalBytes(), used = SD.usedBytes();
    uint64_t freeB = total > used ? total - used : 0;
    if (total > 0 && (freeB >> 20) == 0) {
        freeMB = 0;
        state = SD_FULL;
    } else {
        freeMB = lastKnown;
        state = SD_ERROR;
    }
    SD.end();
}

bool sdProbe() {
    SdLock l;
    if (stream) stream.close();
    streamName[0] = 0;
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

// True iff `name` is PREFIX*.EXT (both already upper-case, since sdValidName
// rejected anything else before this is ever called).
static bool hasPrefixExt(const char* name, const char* prefix, const char* ext) {
    size_t pl = strlen(prefix);
    if (strncmp(name, prefix, pl) != 0) return false;
    const char* dot = strchr(name, '.');
    return dot && strcmp(dot + 1, ext) == 0;
}

// Insertion-sort `name` into `arr` (descending, i.e. newest/highest-numbered
// first), keeping at most `capMax` entries. Anything that doesn't make the
// cut is simply not kept -- older rotations, not deleted.
static void insertTop(SdEntry* arr, size_t& n, size_t capMax, const char* name, uint32_t size) {
    size_t i;
    if (n < capMax) {
        i = n++;
    } else if (strcmp(name, arr[capMax - 1].name) > 0) {
        i = capMax - 1;
    } else {
        return;   // at capacity and not newer than the weakest kept entry
    }
    while (i > 0 && strcmp(arr[i - 1].name, name) < 0) {
        arr[i] = arr[i - 1];
        i--;
    }
    strncpy(arr[i].name, name, 12);
    arr[i].name[12] = 0;
    arr[i].size = size;
}

size_t sdList(SdEntry* out, size_t max, size_t* totalOut) {
    SdLock l;
    if (totalOut) *totalOut = 0;
    if (state != SD_OK) return 0;
    File dir = SD.open(SD_DIR);
    if (!dir) return 0;

    static const size_t KEEP = 64;         // newest kept per rotation family
    static const size_t OTHER_MAX = 32;    // room for anything else valid
    // static, not stack: ~2.7 KB of scratch on top of a caller's own locals
    // (a bench harness with a 4 KB buffer of its own, or a small BLE/loop
    // task stack) is exactly the kind of frame that tips a stack over with no
    // warning until it does -- sdList() is already single-caller-at-a-time
    // behind SdLock, so there's no reentrancy to protect against.
    static SdEntry logKeep[KEEP];
    static SdEntry capKeep[KEEP];
    static SdEntry other[OTHER_MAX];
    size_t logN = 0, capN = 0, otherN = 0;

    for (File e = dir.openNextFile(); e; e = dir.openNextFile()) {
        if (e.isDirectory()) continue;
        const char* full = e.name();
        const char* base = strrchr(full, '/');
        base = base ? base + 1 : full;
        if (!sdValidName(base)) continue;
        if (totalOut) (*totalOut)++;
        uint32_t sz = (uint32_t)e.size();
        if (hasPrefixExt(base, "LOG", "CSV")) {
            insertTop(logKeep, logN, KEEP, base, sz);
        } else if (hasPrefixExt(base, "CAP", "SSC")) {
            insertTop(capKeep, capN, KEEP, base, sz);
        } else if (otherN < OTHER_MAX) {
            strncpy(other[otherN].name, base, 12);
            other[otherN].name[12] = 0;
            other[otherN].size = sz;
            otherN++;
        }
    }

    size_t n = 0;
    for (size_t i = 0; i < logN && n < max; i++) out[n++] = logKeep[i];
    for (size_t i = 0; i < capN && n < max; i++) out[n++] = capKeep[i];
    for (size_t i = 0; i < otherN && n < max; i++) out[n++] = other[i];
    return n;
}

int32_t sdRead(const char* name, uint32_t off, uint8_t* buf, size_t n, uint32_t* sizeOut) {
    SdLock l;
    if (state != SD_OK || !sdValidName(name)) return -1;
    if (streamName[0] && strcmp(name, streamName) == 0) return -1;   // being written right now
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

bool sdIsOpen(const char* name) {
    SdLock l;
    return name && streamName[0] && strcmp(name, streamName) == 0;
}

bool sdRemove(const char* name) {
    SdLock l;
    if (state != SD_OK || !sdValidName(name)) return false;
    if (streamName[0] && strcmp(name, streamName) == 0) return false;   // being written right now
    char path[32];
    pathOf(name, path);
    return SD.remove(path);
}

// One directory pass for the highest CAPnnnnn.SSC, then one past it. The old
// probe-each-number loop was an exists() per capture already on the card.
bool sdNextCaptureName(char out[13]) {
    SdLock l;
    if (state != SD_OK) return false;
    File dir = SD.open(SD_DIR);
    if (!dir) return false;
    uint32_t maxN = 0;
    for (File e = dir.openNextFile(); e; e = dir.openNextFile()) {
        if (e.isDirectory()) continue;
        const char* full = e.name();
        const char* base = strrchr(full, '/');
        base = base ? base + 1 : full;
        if (!sdValidName(base) || !hasPrefixExt(base, "CAP", "SSC")) continue;
        uint32_t n = 0;
        const char* p = base + 3;
        for (; *p >= '0' && *p <= '9'; p++) n = n * 10 + (uint32_t)(*p - '0');
        if (*p == '.' && n > maxN) maxN = n;
    }
    if (maxN >= 99999) return false;
    snprintf(out, 13, "CAP%05u.SSC", (unsigned)(maxN + 1));
    return true;
}

bool sdStreamOpen(const char* name) {
    SdLock l;
    if (state != SD_OK || !sdValidName(name) || stream) return false;
    char path[32];
    pathOf(name, path);
    stream = SD.open(path, FILE_WRITE);
    if (!stream) { fail(); return false; }
    strncpy(streamName, name, 12);
    streamName[12] = 0;
    return true;
}

bool sdStreamWrite(const uint8_t* data, size_t len) {
    SdLock l;
    if (state != SD_OK || !stream) return false;
    if (!writeGuard(len)) return false;
    if (stream.write(data, len) != len) { fail(); return false; }
    return true;
}

bool sdStreamSync() {
    SdLock l;
    if (state != SD_OK || !stream) return false;
    stream.flush();
    return true;
}

void sdStreamClose() {
    SdLock l;
    if (stream) stream.close();
    streamName[0] = 0;
}
