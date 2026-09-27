// Host-side tests for the attack-detector window logic. Compiled with plain
// g++ (no ESP headers): the header is <stdint.h>/<string.h> only. These pin
// the sliding-window math the firmware runs verbatim -- a byte-off window is
// the Remote ID offset bug again (silent, every count wrong).
#include "../src/attack_detectors.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <cctype>

static uint64_t mac(uint8_t last) { uint8_t m[6] = {0xDE,0xAD,0,0,0,last}; return attackMac48(m); }
static uint64_t ssid(const char* s) { return attackHash((const uint8_t*)s, (int)strlen(s)); }

static void test_deauth_fires_at_threshold() {
    DeauthState st; memset(&st, 0, sizeof(st));
    uint32_t c = 0;
    for (int i = 0; i < ATTACK_DEAUTH_THRESHOLD; i++) c = deauthNote(&st, mac(1), 0, 1000 + i);
    assert(c == ATTACK_DEAUTH_THRESHOLD);          // exactly at threshold
    // one short of threshold from a different tx must not be conflated
    DeauthState st2; memset(&st2, 0, sizeof(st2));
    for (int i = 0; i < ATTACK_DEAUTH_THRESHOLD - 1; i++) assert(deauthNote(&st2, mac(2), 0, 1000 + i) < ATTACK_DEAUTH_THRESHOLD);
}

static void test_deauth_slow_trickle_never_fires() {
    DeauthState st; memset(&st, 0, sizeof(st));
    uint32_t c = 0;
    // one frame every 1000 ms: the window (5 s) never holds >= 10.
    for (int i = 0; i < 50; i++) c = deauthNote(&st, mac(1), 0, 1000 + i * 1000);
    assert(c < ATTACK_DEAUTH_THRESHOLD);
}

static void test_deauth_broadcast_counts_double() {
    DeauthState st; memset(&st, 0, sizeof(st));
    uint32_t c = 0;
    // 5 broadcast frames == 10 counted -> fires.
    for (int i = 0; i < 5; i++) c = deauthNote(&st, mac(1), 1 /*broadcast*/, 1000 + i);
    assert(c >= ATTACK_DEAUTH_THRESHOLD);
}

static void test_deauth_window_slides() {
    DeauthState st; memset(&st, 0, sizeof(st));
    for (int i = 0; i < ATTACK_DEAUTH_THRESHOLD; i++) deauthNote(&st, mac(1), 0, 1000 + i);
    // 6 s later a single frame: all the old ones have aged out of the 5 s window.
    uint32_t c = deauthNote(&st, mac(1), 0, 1000 + 6000);
    assert(c == 1);
}

static void test_deauth_wrap_safe() {
    DeauthState st; memset(&st, 0, sizeof(st));
    uint32_t base = 0xFFFFF000u; // ~4 s before wrap
    uint32_t c = 0;
    for (int i = 0; i < ATTACK_DEAUTH_THRESHOLD; i++) c = deauthNote(&st, mac(1), 0, base + i * 100); // crosses UINT32_MAX->0
    assert(c == ATTACK_DEAUTH_THRESHOLD); // window math must not blow up across the wrap
}

static void test_deauth_lru_keeps_active_burster() {
    DeauthState st; memset(&st, 0, sizeof(st));
    // Prime an ongoing burster (tx 0) with recent frames.
    for (int i = 0; i < ATTACK_DEAUTH_THRESHOLD - 1; i++) deauthNote(&st, mac(0), 0, 2000 + i);
    // Fill the other 7 slots + a 9th distinct tx, all with OLDER lastSeen.
    for (uint8_t k = 1; k <= ATTACK_LRU_SLOTS; k++) deauthNote(&st, mac(k), 0, 1000);
    // The burster's next frame must still see its own history (not be evicted).
    uint32_t c = deauthNote(&st, mac(0), 0, 2100);
    assert(c >= ATTACK_DEAUTH_THRESHOLD);
}

static void test_karma_distinct_ssids() {
    KarmaState st; memset(&st, 0, sizeof(st));
    uint32_t c = 0;
    const char* names[] = {"HomeWiFi", "attwifi", "xfinity", "Starbucks"};
    for (int i = 0; i < 4; i++) c = karmaNote(&st, mac(9), ssid(names[i]), 1000 + i);
    assert(c >= ATTACK_KARMA_THRESHOLD);
    // 4 repeats of the SAME ssid from the same BSSID is a normal AP, not karma.
    KarmaState st2; memset(&st2, 0, sizeof(st2));
    uint32_t c2 = 0;
    for (int i = 0; i < 8; i++) c2 = karmaNote(&st2, mac(9), ssid("HomeWiFi"), 1000 + i);
    assert(c2 == 1);
}

static void test_blespam_distinct_random_macs() {
    BleSpamState st; memset(&st, 0, sizeof(st));
    uint32_t c = 0;
    for (uint8_t i = 0; i < ATTACK_BLESPAM_THRESHOLD; i++) c = bleSpamNote(&st, mac(i), 1000 + i);
    assert(c >= ATTACK_BLESPAM_THRESHOLD);
    // The same rotating attacker MAC re-seen does not inflate the count.
    BleSpamState st2; memset(&st2, 0, sizeof(st2));
    uint32_t c2 = 0;
    for (int i = 0; i < 20; i++) c2 = bleSpamNote(&st2, mac(1), 1000 + i);
    assert(c2 == 1);
}

static void test_titles_keyword_clean() {
    const char* titles[] = {ATTACK_TITLE_DEAUTH, ATTACK_TITLE_KARMA, ATTACK_TITLE_BLESPAM};
    const char* kw[] = {"tag","track","beacon","cam","surveil","drone","uas","body","axon","glasses","flock","alpr","plate"};
    for (const char* t : titles) { char lc[64]; int n=0; for (; t[n] && n<63; n++) lc[n]=(char)tolower(t[n]); lc[n]=0;
        for (const char* k : kw) assert(strstr(lc, k) == nullptr); }
}

int main() {
    test_deauth_fires_at_threshold();
    test_deauth_slow_trickle_never_fires();
    test_deauth_broadcast_counts_double();
    test_deauth_window_slides();
    test_deauth_wrap_safe();
    test_deauth_lru_keeps_active_burster();
    test_karma_distinct_ssids();
    test_blespam_distinct_random_macs();
    test_titles_keyword_clean();
    printf("attack_detectors_test: all passed\n");
    return 0;
}
