// Host-side tests for the Lights + brightness rules. Compiled with plain g++
// (no ESP headers): the header is <stdint.h> only. Covers the {"led"} and
// {"bri"} wire mapping, the legacy reported `led`, the Night Ops cap, the NVS
// load and migration, and clamping of out-of-range values.
#include "../src/led_brightness.h"
#include <cassert>
#include <cstdio>

// Old app picks Dim: {"led":2} -> Bar + Low; reports led 2, bri 0.
static void test_old_app_dim() {
    LedState s = ledApplyCommand(2, BRI_HIGH);
    assert(s.led == LED_FULL && s.bri == BRI_LOW);
    assert(ledReported(s.led, s.bri) == 2);
}

// Old app picks Full: {"led":3} -> Bar + High; reports led 3, bri 2.
static void test_old_app_full() {
    LedState s = ledApplyCommand(3, BRI_LOW);
    assert(s.led == LED_FULL && s.bri == BRI_HIGH);
    assert(ledReported(s.led, s.bri) == 3);
}

// New app picks Bar at Med: {"led":4} with bri 1 -> Med kept; reports led 3, bri 1.
static void test_new_app_bar_keeps_med() {
    LedState s = ledApplyCommand(4, BRI_MED);
    assert(s.led == LED_FULL && s.bri == BRI_MED);
    assert(ledReported(s.led, s.bri) == 3);
}

// Off and One keep the brightness; One reports 1 whatever the brightness.
static void test_off_one_keep_brightness() {
    LedState s = ledApplyCommand(0, BRI_MED);
    assert(s.led == LED_OFF && s.bri == BRI_MED && ledReported(s.led, s.bri) == 0);
    s = ledApplyCommand(1, BRI_LOW);
    assert(s.led == LED_ONE && s.bri == BRI_LOW && ledReported(s.led, s.bri) == 1);
}

// Brightness change: {"bri":N} sets brightness only; Lights is unchanged and
// the reported `led` follows the new brightness.
static void test_bri_change_leaves_lights() {
    LedState s = briApplyCommand(LedState{LED_FULL, BRI_HIGH}, 1);
    assert(s.led == LED_FULL && s.bri == BRI_MED);
    assert(ledReported(s.led, s.bri) == 3);
    s = briApplyCommand(s, 0);
    assert(s.led == LED_FULL && s.bri == BRI_LOW);
    assert(ledReported(s.led, s.bri) == 2);   // Bar at Low reads as Dim to old apps
    s = briApplyCommand(LedState{LED_ONE, BRI_HIGH}, 0);
    assert(s.led == LED_ONE && s.bri == BRI_LOW && ledReported(s.led, s.bri) == 1);
    s = briApplyCommand(LedState{LED_OFF, BRI_LOW}, 2);
    assert(s.led == LED_OFF && s.bri == BRI_HIGH && ledReported(s.led, s.bri) == 0);
}

// Night Ops caps at Low, except under One; outside Night, the setting rules.
static void test_night_cap() {
    assert(ledRenderBri(LED_FULL, BRI_HIGH, true) == BRI_LOW);
    assert(ledRenderBri(LED_OFF, BRI_HIGH, true) == BRI_LOW);
    assert(ledRenderBri(LED_ONE, BRI_HIGH, true) == BRI_HIGH);   // One exempt
    assert(ledRenderBri(LED_ONE, BRI_MED, false) == BRI_MED);    // applies to One
    assert(ledRenderBri(LED_FULL, BRI_MED, false) == BRI_MED);
}

// Upgrade: NVS led 2 and no bri key -> Bar + Low; led 3 -> Bar + High;
// with a bri key, it is used (clamped) and a stored Bar is LED_FULL.
static void test_nvs_load() {
    LedState s = ledLoadNvs(2, false, 0);
    assert(s.led == LED_FULL && s.bri == BRI_LOW);
    s = ledLoadNvs(3, false, 0);
    assert(s.led == LED_FULL && s.bri == BRI_HIGH);
    s = ledLoadNvs(1, false, 0);
    assert(s.led == LED_ONE && s.bri == BRI_HIGH);
    s = ledLoadNvs(3, true, BRI_MED);
    assert(s.led == LED_FULL && s.bri == BRI_MED);
    s = ledLoadNvs(0, true, 9);
    assert(s.led == LED_OFF && s.bri == BRI_HIGH);
    s = ledLoadNvs(200, true, BRI_LOW);
    assert(s.led == LED_FULL && s.bri == BRI_LOW);
}

// Bad values: {"led":9} clamps to 4 (Bar, keep brightness); {"bri":7} clamps to 2.
static void test_bad_values() {
    LedState s = ledApplyCommand(9, BRI_MED);
    assert(s.led == LED_FULL && s.bri == BRI_MED);
    assert(briClamp(7) == BRI_HIGH);
    s = briApplyCommand(LedState{LED_ONE, BRI_LOW}, 7);
    assert(s.led == LED_ONE && s.bri == BRI_HIGH);
}

int main() {
    test_old_app_dim();
    test_old_app_full();
    test_new_app_bar_keeps_med();
    test_off_one_keep_brightness();
    test_bri_change_leaves_lights();
    test_night_cap();
    test_nvs_load();
    test_bad_values();
    printf("led_brightness_test: all passed\n");
    return 0;
}
