// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#ifndef CAPABILITIES_H
#define CAPABILITIES_H

#include <Arduino.h>

/**
 * Hardware capability seam for the tiered build.
 *
 * Compile-time flags (set per env in platformio.ini) decide what code links.
 * Runtime probes decide what's actually plugged in. Tier 1 defines none of
 * these, so every HAS_* is false and the firmware runs phone-UI / single-radio.
 *
 *   HAS_SECOND_RADIO  Tier 2+  dedicated BLE co-radio (WiFi runs full-time)
 *   HAS_SCREEN        Tier 2+  onboard display
 *   HAS_BATTERY       Tier 2+  battery + fuel gauge
 *   HAS_GPS           Tier 3   onboard GPS module (else location comes from app)
 *   HAS_BUTTONS       Tier 3   physical config buttons
 *
 * Real driver code doesn't exist yet; guard future hardware code with these
 * #ifdefs so it slots in without forking the firmware.
 */

struct Capabilities {
    bool secondRadio;
    bool screen;
    bool battery;
    bool gps;
    bool buttons;
};

/**
 * @brief What this build was compiled with. Runtime presence probes (is the
 * GPS getting a fix, is the antenna connected) get added here as the Tier 2/3
 * hardware lands — for now "compiled in" == "present".
 */
inline Capabilities getCapabilities() {
    Capabilities c = {false, false, false, false, false};
#ifdef HAS_SECOND_RADIO
    c.secondRadio = true;
#endif
#ifdef HAS_SCREEN
    c.screen = true;
#endif
#ifdef HAS_BATTERY
    c.battery = true;
#endif
#ifdef HAS_GPS
    c.gps = true;
#endif
#ifdef HAS_BUTTONS
    c.buttons = true;
#endif
    return c;
}

/**
 * @brief Tier number implied by the compiled capabilities (1/2/3). Used for the
 * NVS board self-ID that a future flash.py --auto reads back over serial.
 * ponytail: derived from flags now; swap for an ADC ID-resistor read when
 * Tier 2/3 boards ship a hardware ID pin.
 */
inline int getTier() {
    Capabilities c = getCapabilities();
    if (c.gps || c.buttons) return 3;
    if (c.secondRadio || c.screen || c.battery) return 2;
    return 1;
}

#endif // CAPABILITIES_H
