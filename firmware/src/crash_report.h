// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
//
// The last crash, kept across the reset it caused (idea from SquachWatch-CYD).
// A breadcrumb in no-init RAM (uptime, internal heap, targets) plus the core
// dump summary IDF writes to the coredump partition. Reported once on USB at
// boot and in CMD:CFG as "crash" until the next non-crash boot.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

void crashReportInit();                      // first thing in setup(), before anything allocates
// Once a second from the detector's 1 Hz body. Gap: that task deletes itself
// while a capture runs, so a crash mid-capture reports the capture-start values.
void crashBreadcrumbTick(uint32_t targets);
bool crashReportPresent();
void crashReportToJson(JsonObject o);        // task, pc, bt[], up/heap/tgt (omitted if unknown), dump, same
