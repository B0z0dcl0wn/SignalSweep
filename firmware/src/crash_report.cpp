// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
#include "crash_report.h"
#include <esp_system.h>
#include <esp_attr.h>
#include <esp_heap_caps.h>
#include <esp_idf_version.h>
#include <string.h>
#if __has_include(<esp_core_dump.h>)
#include <esp_core_dump.h>
#endif
#if ESP_IDF_VERSION_MAJOR >= 5
#include <esp_app_desc.h>      // esp_app_get_elf_sha256 (IDF 5.x, the C5)
#else
#include <esp_ota_ops.h>       // esp_ota_get_app_elf_sha256 (IDF 4.4, the S3)
#endif

#if defined(CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH) && defined(CONFIG_ESP_COREDUMP_DATA_FORMAT_ELF)
#define SWEEP_HAVE_COREDUMP 1
#else
#define SWEEP_HAVE_COREDUMP 0
#endif

// __NOINIT_ATTR: section ".noinit", NOLOAD in internal SRAM on both targets
// (S3 sections.ld and C5 sections.ld), so startup neither loads nor zeroes it
// and it survives a software/panic/watchdog reset. RTC_NOINIT_ATTR is not
// guaranteed on the C5. A power-on leaves it random, hence the magic + checks.
static const uint32_t CRUMB_MAGIC = 0x53574350u;   // "SWCP"
__NOINIT_ATTR static struct { uint32_t magic, up, heap, tgt; } crumb;

static struct {
    bool     valid = false, haveDump = false, same = false;
    uint32_t up = 0, heap = 0, tgt = 0, pc = 0;
    uint32_t bt[4] = { 0, 0, 0, 0 };
    uint8_t  btN = 0;
    char     task[16] = { 0 };
} last;

void crashReportInit() {
    const esp_reset_reason_t r = esp_reset_reason();
    // ESP_RST_WDT (RTC/other watchdog) counts too: it is what fires if the
    // panic handler itself hangs, and RAM survives it like the others.
    const bool crashed = (r == ESP_RST_PANIC || r == ESP_RST_INT_WDT ||
                          r == ESP_RST_TASK_WDT || r == ESP_RST_WDT);
    // A power-on leaves random RAM: believe the magic only after a crash reset,
    // and only with plausible values (a half-surviving image can carry the
    // magic with garbage behind it).
    if (crashed) {
        last.valid = true;
        if (crumb.magic == CRUMB_MAGIC && crumb.up < 400UL * 24 * 3600 && crumb.heap < 1024UL * 1024) {
            last.up = crumb.up; last.heap = crumb.heap; last.tgt = crumb.tgt;
        }
#if SWEEP_HAVE_COREDUMP
        // Static, not a local: on the C5 (RISC-V) the summary embeds a 1 KB
        // stack dump (CONFIG_ESP_COREDUMP_SUMMARY_STACKDUMP_SIZE), too much for
        // the loop task's stack for no reason. Read once per boot.
        static esp_core_dump_summary_t s;
        if (esp_core_dump_get_summary(&s) == ESP_OK) {
            last.haveDump = true;
            strncpy(last.task, s.exc_task, sizeof(last.task) - 1);
            last.pc = s.exc_pc;
#if defined(__XTENSA__)
            // Xtensa (S3) backtraces on device. Skip a leading frame equal to PC.
            uint32_t i = (s.exc_bt_info.depth && s.exc_bt_info.bt[0] == s.exc_pc) ? 1 : 0;
            for (; i < s.exc_bt_info.depth && i < 16 && last.btN < 4; i++) last.bt[last.btN++] = s.exc_bt_info.bt[i];
#else
            // RISC-V (C5) cannot backtrace on device; the return address is the
            // one caller we get. The full stack is in the dump for esp-coredump.
            last.bt[0] = s.ex_info.ra;
            last.btN = 1;
#endif
            char running[65] = { 0 };
#if ESP_IDF_VERSION_MAJOR >= 5
            esp_app_get_elf_sha256(running, sizeof(running));
#else
            esp_ota_get_app_elf_sha256(running, sizeof(running));
#endif
            // The dump stores only CONFIG_APP_RETRIEVE_LEN_ELF_SHA hex chars of
            // the ELF hash (16 on the S3 build, 9 including the NUL on the C5),
            // so compare exactly as many as it holds -- a fixed 16 would call
            // every C5 crash "different firmware".
            const size_t n = strnlen((const char*)s.app_elf_sha256, sizeof(s.app_elf_sha256));
            last.same = n > 0 && strncmp((const char*)s.app_elf_sha256, running, n) == 0;
        }
#endif
    }
    crumb.magic = CRUMB_MAGIC;
    crumb.up = 0; crumb.heap = 0; crumb.tgt = 0;
    if (last.valid) {
        Serial.printf("[CRASH] reset=%d task=%s pc=0x%08lx bt=", (int)r, last.task[0] ? last.task : "?",
                      (unsigned long)last.pc);
        for (uint8_t i = 0; i < last.btN; i++) Serial.printf("%s0x%08lx", i ? "," : "", (unsigned long)last.bt[i]);
        Serial.printf(" up=%lu heap=%lu tgt=%lu dump=%d same_fw=%d\n", (unsigned long)last.up,
                      (unsigned long)last.heap, (unsigned long)last.tgt, (int)last.haveDump, (int)last.same);
    }
}

void crashBreadcrumbTick(uint32_t targets) {
    crumb.up = millis() / 1000;
    crumb.heap = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    crumb.tgt = targets;
}

bool crashReportPresent() { return last.valid; }

void crashReportToJson(JsonObject o) {
    char pc[11];
    snprintf(pc, sizeof(pc), "0x%08lx", (unsigned long)last.pc);
    o["task"] = last.task;
    o["pc"] = pc;
    JsonArray bt = o["bt"].to<JsonArray>();
    for (uint8_t i = 0; i < last.btN; i++) {
        char a[11];
        snprintf(a, sizeof(a), "0x%08lx", (unsigned long)last.bt[i]);
        bt.add(a);
    }
    o["up"] = last.up;
    o["heap"] = last.heap;
    o["tgt"] = last.tgt;
    o["dump"] = last.haveDump;
    o["same"] = last.same;
}
