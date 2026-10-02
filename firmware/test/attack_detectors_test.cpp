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
    // half-threshold broadcast frames, each counted twice -> fires.
    for (int i = 0; i < (ATTACK_DEAUTH_THRESHOLD + 1) / 2; i++) c = deauthNote(&st, mac(1), 1 /*broadcast*/, 1000 + i);
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
    uint32_t base = 0xFFFFFC00u; // ~1 s before wrap, so the burst really crosses it
    uint32_t c = 0;
    for (int i = 0; i < ATTACK_DEAUTH_THRESHOLD; i++) c = deauthNote(&st, mac(1), 0, base + i * 100); // crosses UINT32_MAX->0
    assert(c == ATTACK_DEAUTH_THRESHOLD); // window math must not blow up across the wrap
}

static void test_deauth_lru_keeps_active_burster() {
    // Time only moves forward -- millis() never runs backward across
    // transmitters -- so this drives the LRU with a monotonic clock and
    // still proves an active burster survives being the least-recently-
    // touched-by-key slot at the moment a 9th distinct tx needs a slot.
    DeauthState st; memset(&st, 0, sizeof(st));
    // t=1000: seed 7 other transmitters (7 of the 8 slots), all older.
    for (uint8_t k = 1; k <= ATTACK_LRU_SLOTS - 1; k++) deauthNote(&st, mac(k), 0, 1000);
    // t=2000..: burst mac(0) into the 8th (last) slot -- newest lastSeen.
    // Later times are derived from the burst end so the clock never steps
    // back, whatever ATTACK_DEAUTH_THRESHOLD is.
    uint32_t t = 2000;
    for (int i = 0; i < ATTACK_DEAUTH_THRESHOLD - 1; i++) deauthNote(&st, mac(0), 0, t++);
    // a 9th distinct tx needs a slot; must evict one of the OLDER
    // (t=1000) transmitters, never the just-active burster.
    deauthNote(&st, mac(8), 0, t++);
    // the burster's next frame must still see its own history.
    uint32_t c = deauthNote(&st, mac(0), 0, t);
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
    for (uint8_t i = 0; i < ATTACK_BLESPAM_THRESHOLD; i++) c = bleSpamNote(&st, mac(i), -40, 1000 + i);
    assert(c >= ATTACK_BLESPAM_THRESHOLD);
    // The same rotating attacker MAC re-seen does not inflate the count.
    BleSpamState st2; memset(&st2, 0, sizeof(st2));
    uint32_t c2 = 0;
    for (int i = 0; i < 20; i++) c2 = bleSpamNote(&st2, mac(1), -40, 1000 + i);
    assert(c2 == 1);
}

// A crowd of real AirPods at the edge of range (2026-10-01 lot capture) must
// not trip it: adverts under the RSSI floor are not counted at all, and they
// must not pad a count that near adverts are building either.
static void test_blespam_weak_adverts_ignored() {
    BleSpamState st; memset(&st, 0, sizeof(st));
    uint32_t c = 0;
    for (uint8_t i = 0; i < 20; i++) c = bleSpamNote(&st, mac(i), ATTACK_BLESPAM_MIN_RSSI - 1, 1000 + i);
    assert(c == 0);
    for (uint8_t i = 20; i < 20 + ATTACK_BLESPAM_THRESHOLD - 1; i++) c = bleSpamNote(&st, mac(i), ATTACK_BLESPAM_MIN_RSSI, 1100 + i);
    assert(c == ATTACK_BLESPAM_THRESHOLD - 1);   // the 20 weak ones added nothing
    c = bleSpamNote(&st, mac(99), ATTACK_BLESPAM_MIN_RSSI, 1200);
    assert(c >= ATTACK_BLESPAM_THRESHOLD);       // at the floor still counts
}

static void test_blespam_distinct_set_over_capacity() {
    // Push more distinct MACs than ATTACK_DISTINCT_CAP (16) inside one window:
    // the set must keep overwriting its oldest entry (wrap-safe age pick) and
    // never miscount or corrupt -- capped at ATTACK_DISTINCT_CAP, not silently
    // wrong.
    BleSpamState st; memset(&st, 0, sizeof(st));
    uint32_t c = 0;
    for (int i = 0; i < ATTACK_DISTINCT_CAP + 5; i++) c = bleSpamNote(&st, mac((uint8_t)i), -40, 1000 + (uint32_t)i);
    assert(c == ATTACK_DISTINCT_CAP);          // saturates at the set's capacity
    assert(c >= ATTACK_BLESPAM_THRESHOLD);     // still well past the fire threshold
}

static void test_titles_keyword_clean() {
    const char* titles[] = {ATTACK_TITLE_DEAUTH, ATTACK_TITLE_KARMA, ATTACK_TITLE_BLESPAM};
    const char* kw[] = {"tag","track","beacon","cam","surveil","drone","uas","body","axon","glasses","flock","alpr","plate"};
    for (const char* t : titles) { char lc[64]; int n=0; for (; t[n] && n<63; n++) lc[n]=(char)tolower(t[n]); lc[n]=0;
        for (const char* k : kw) assert(strstr(lc, k) == nullptr); }
}

static void addrs(TagFloodState* st, int n, uint8_t base, uint32_t t0, uint32_t gap) {
    for (int i = 0; i < n; i++) tagFloodNote(st, mac((uint8_t)(base + i)), t0 + i * gap);
}
static void test_tagflood_stable_never_evidence() {
    TagFloodState st; memset(&st, 0, sizeof(st));
    for (int i = 0; i < 1800; i++) tagFloodNote(&st, mac(1), 1000 + i * 2000);  // 1 h at 2 s
    assert(st.total == 0 && !tagFloodActive(&st, 1000 + 1800 * 2000));
}
static void test_tagflood_six_trips_five_doesnt() {
    TagFloodState st; memset(&st, 0, sizeof(st));
    addrs(&st, 5, 10, 1000, 10000);                    // 5 one-shot addresses
    tagFloodNote(&st, mac(200), 200000);               // sweep: all 5 quiet >= 30 s
    assert(st.total == 5 && !tagFloodActive(&st, 200000));
    TagFloodState s2; memset(&s2, 0, sizeof(s2));
    addrs(&s2, 6, 10, 1000, 10000);
    tagFloodNote(&s2, mac(200), 200000);
    assert(s2.total == 6 && tagFloodActive(&s2, 200000));
}
static void test_tagflood_five_no_trip() {             // spread beyond the 5-min window
    TagFloodState st; memset(&st, 0, sizeof(st));
    // one one-shot passer every 70 s; each is swept by the next, so 6 stamps
    // span 350 s > WINDOW and it never trips
    for (int i = 0; i < 12; i++) tagFloodNote(&st, mac((uint8_t)(10 + i)), 1000 + i * 70000);
    assert(st.total == 11);
    assert(!tagFloodActive(&st, 1000 + 12 * 70000));
}
static void test_tagflood_hold_expires() {
    TagFloodState st; memset(&st, 0, sizeof(st));
    addrs(&st, 6, 10, 1000, 1000);
    tagFloodNote(&st, mac(200), 60000);
    assert(tagFloodActive(&st, 60000));
    // Evidence is dated when the address went quiet (last + QUIET), not when
    // the lazy sweep noticed: the last fake was heard at 6000.
    uint32_t le = st.lastEvidence;
    assert(le == 6000 + TAGFLOOD_QUIET_MS);
    assert(tagFloodActive(&st, le + TAGFLOOD_HOLD_MS - 1));
    assert(!tagFloodActive(&st, le + TAGFLOOD_HOLD_MS));
    assert(st.total == 0);                             // reset for the next flood
}
// Review finding: the fakes left in the ring when a flood stops are swept by
// the NEXT advert of that type, hours later. Dated at the sweep, they re-tripped
// the gate and muted the first real tag to show up.
static void test_tagflood_stale_ring_no_retrip() {
    TagFloodState st; memset(&st, 0, sizeof(st));
    addrs(&st, 45, 10, 1000, 4000);                    // 3 min, one fake per 4 s
    assert(tagFloodActive(&st, 1000 + 44 * 4000));
    uint32_t later = 1000 + 44 * 4000 + 3u * 3600u * 1000u;
    tagFloodNote(&st, mac(250), later);                // a real tag, 3 h on
    assert(!tagFloodActive(&st, later));
}
// Review finding: one weak real tag heard every 44 s went quiet >= 30 s each
// time and counted as fresh evidence every time -- a false flood from two tags.
static void test_tagflood_same_key_counts_once() {
    TagFloodState st; memset(&st, 0, sizeof(st));
    for (uint32_t t = 1000; t < 1000 + 600000; t += 2000) {
        tagFloodNote(&st, mac(1), t);                  // strong stable tag
        if ((t - 1000) % 44000 == 0) tagFloodNote(&st, mac(2), t);   // weak one
        assert(!tagFloodActive(&st, t));
    }
}
static void test_tagflood_fast_flood_trips() {         // 100 addresses in 10 s, ring is 32
    TagFloodState st; memset(&st, 0, sizeof(st));
    addrs(&st, 100, 0, 1000, 100);
    assert(tagFloodActive(&st, 11000));
}
static void test_tagflood_wrap_safe() {
    TagFloodState st; memset(&st, 0, sizeof(st));
    uint32_t t0 = 0xFFFFFFFFu - 20000;
    addrs(&st, 6, 10, t0, 1000);
    tagFloodNote(&st, mac(200), t0 + 60000);           // wraps
    assert(tagFloodActive(&st, t0 + 60000));
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
    test_blespam_weak_adverts_ignored();
    test_blespam_distinct_set_over_capacity();
    test_titles_keyword_clean();
    test_tagflood_stable_never_evidence();
    test_tagflood_six_trips_five_doesnt();
    test_tagflood_five_no_trip();
    test_tagflood_hold_expires();
    test_tagflood_fast_flood_trips();
    test_tagflood_wrap_safe();
    test_tagflood_stale_ring_no_retrip();
    test_tagflood_same_key_counts_once();
    printf("attack_detectors_test: all passed\n");
    return 0;
}
