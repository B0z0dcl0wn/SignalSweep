// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
//
// XIAO ESP32-C5 capture experiment (env:c5): the packet capture and nothing
// else, to learn what the C5 hears before paying for a full port. Speaks the
// USB protocol Site Survey already uses (CMD:CAP:START:<secs> / CMD:CAP:STOP).
// Everything else the app sends (CMD:CFG, CMD:HOST) is ignored on purpose.
#include <Arduino.h>
#include <WiFi.h>
#include <NimBLEDevice.h>
#include <nvs_flash.h>
#include "mode_capture.h"

// mode_capture.cpp pauses and resumes the detector; this build has none.
// ponytail: stubs, the full port links the real detector.
void stopWatchersWatch() {}
void startWatchersWatch() {}

void setup() {
    Serial.begin(115200);
    if (nvs_flash_init() != ESP_OK) { nvs_flash_erase(); nvs_flash_init(); }
    NimBLEDevice::init("");     // scanner only, never advertises
    WiFi.mode(WIFI_STA);
}

void loop() {
    if (Serial.available()) {
        String s = Serial.readStringUntil('\n');
        s.trim();
        if (s.startsWith("CMD:CAP:START:")) {   // CMD:CAP:START:<secs>[:<A-D hop profile>]
            int c = s.lastIndexOf(':');
            setCaptureProfile(c > 13 ? s.charAt(c + 1) : 'A');
            startCapture((uint32_t)s.substring(14).toInt());
        }
        else if (s == "CMD:CAP:STOP") stopCapture();
        else if (s == "CMD:C5") {   // bench witness: is this the C5 build, and is PSRAM there?
            Serial.printf("[C5] %s rev%d psram=%u heap=%u capturing=%d\n", ESP.getChipModel(),
                          ESP.getChipRevision(), (unsigned)ESP.getPsramSize(),
                          (unsigned)ESP.getFreeHeap(), isCapturing());
        }
    }
    captureTick();
    delay(10);
}
