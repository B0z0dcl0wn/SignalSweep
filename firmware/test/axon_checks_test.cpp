// Host-side tests for the v23 Axon payload checks (src/axon_checks.h). Plain
// g++, no ESP headers. The squatter case is RF Sentinel's DetectionTest.kt:56
// (CIS-C0/RFSentinel 843c738, GPL-3.0): the IDO watch "IDW26" at
// F4:FD:16:03:54:5B, sending 0x034D with its own address first.
#include "../src/axon_checks.h"
#include <cassert>
#include <cstdio>
#include <initializer_list>

static const uint8_t WATCH_ADDR[6] = {0xF4, 0xFD, 0x16, 0x03, 0x54, 0x5B};
// Company ID 0x034D little-endian, then the payload from DetectionTest.kt:56.
static const uint8_t WATCH_MFG[] = {0x4D, 0x03, 0xF4, 0xFD, 0x16, 0x03, 0x54, 0x5B, 2, 1, 0x10, 1, 1, 1};

static void test_ido_watch_is_a_squatter() {
    // The watch as captured: name and service 0x0AF0 both present.
    assert(taserIdSquatter(WATCH_MFG, sizeof(WATCH_MFG), WATCH_ADDR, true, "IDW26"));
    // Either tell alone is enough.
    assert(taserIdSquatter(WATCH_MFG, sizeof(WATCH_MFG), WATCH_ADDR, true, nullptr));
    assert(taserIdSquatter(WATCH_MFG, sizeof(WATCH_MFG), WATCH_ADDR, false, "IDW26"));
}

static void test_same_payload_without_a_watch_tell_stays_axon() {
    // DetectionTest.kt:56's second half: the same payload, no name, no service.
    static const uint8_t mfg[] = {0x4D, 0x03, 0xF4, 0xFD, 0x16, 0x03, 0x54, 0x5B, 2, 1};
    assert(!taserIdSquatter(mfg, sizeof(mfg), WATCH_ADDR, false, nullptr));
    assert(!taserIdSquatter(mfg, sizeof(mfg), WATCH_ADDR, false, "Axon Body 4"));
}

static void test_payload_not_repeating_the_address_stays_axon() {
    // OVERWATCH's one Axon-block capture shape: 0x02 + a nine-char serial.
    static const uint8_t mfg[] = {0x4D, 0x03, 0x02, 'X', '8', '7', '0', '0', '5', '4', 'F', 'W'};
    assert(!taserIdSquatter(mfg, sizeof(mfg), WATCH_ADDR, true, "IDW26"));
    // One address byte off is not the address.
    uint8_t other[6] = {0xF4, 0xFD, 0x16, 0x03, 0x54, 0x5C};
    assert(!taserIdSquatter(WATCH_MFG, sizeof(WATCH_MFG), other, true, "IDW26"));
}

static void test_other_company_or_short_payload_never_squats() {
    uint8_t mfg[sizeof(WATCH_MFG)];
    memcpy(mfg, WATCH_MFG, sizeof(mfg));
    mfg[0] = 0x4C; mfg[1] = 0x00;                   // Apple, same bytes after
    assert(!taserIdSquatter(mfg, sizeof(mfg), WATCH_ADDR, true, "IDW26"));
    assert(!taserIdSquatter(WATCH_MFG, 7, WATCH_ADDR, true, "IDW26"));   // 5 payload bytes
    assert(!taserIdSquatter(nullptr, 0, WATCH_ADDR, true, "IDW26"));
}

static void test_ido_name_shape() {
    for (const char* n : {"IDW26", "ID205", "ID207", "IDW26A", "ID1234", "IDA12B"}) assert(idoWatchName(n));
    for (const char* n : {"ID2", "ID12345", "idw26", "IDW26 ", "XIDW26", "IDWW26", "ID26ab", "", "ID"})
        assert(!idoWatchName(n));
    assert(!idoWatchName(nullptr));
}

static void test_fe6c_serial_shapes() {
    static const uint8_t real[] = {0x01, 'X', '8', '7', '0', '0', '5', '4', 'F', 'W', 0x00};
    assert(axonSignalKind(real, sizeof(real)) == AXON_SIG_SERIAL);
    static const uint8_t cadabra[] = {0x01, 'X', '8', '7', '0', '0', '2', 'F', 'P', '4', 0x00};
    assert(axonSignalKind(cadabra, sizeof(cadabra)) == AXON_SIG_CADABRA);
    static const uint8_t five[] = {'A', 'B', '1', '2', '3', 0x00, 'Z'};
    assert(axonSignalKind(five, sizeof(five)) == AXON_SIG_NONE);   // run of 5: too short
    static const uint8_t lower[] = {'X', '8', '7', 'a', '0', '5', '4', 'f', 'W', 'b', 'Q'};
    assert(axonSignalKind(lower, sizeof(lower)) == AXON_SIG_NONE); // lowercase breaks the run
    static const uint8_t binary[] = {0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0};
    assert(axonSignalKind(binary, sizeof(binary)) == AXON_SIG_NONE);
    assert(axonSignalKind(nullptr, 0) == AXON_SIG_NONE);
    assert(axonSignalKind(real, 0) == AXON_SIG_NONE);
}

int main() {
    test_ido_watch_is_a_squatter();
    test_same_payload_without_a_watch_tell_stays_axon();
    test_payload_not_repeating_the_address_stays_axon();
    test_other_company_or_short_payload_never_squats();
    test_ido_name_shape();
    test_fe6c_serial_shapes();
    printf("axon_checks: all tests passed\n");
    return 0;
}
