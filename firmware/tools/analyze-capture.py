#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
"""Analyze a SignalSweep environment capture (.sscap).

A .sscap file is what the app's "Capture environment" screen saves: a header
line, then one base64 record per line, each a raw WiFi frame or BLE advert the
board heard. This finds the signal in the noise -- especially a device that
rotates its MAC but keeps a fixed fingerprint, which is how a modern Flock
camera hides from an OUI-based detector.

  python analyze-capture.py near.sscap                 # summary
  python analyze-capture.py near.sscap --minus far.sscap  # what's only near
  python analyze-capture.py near.sscap --pcap out.pcap     # WiFi -> Wireshark
  python analyze-capture.py --selftest                     # parser self-check

Record layout (little-endian), matching mode_capture.cpp:
  B radio(0=wifi,1=ble)  I seq  I ts_us  B channel  b rssi  H orig_len  H cap_len
  then cap_len payload bytes. BLE payload = 6 MAC (big-endian) + 1 addr_type + adv.
"""
import base64, struct, sys, argparse, os
from collections import defaultdict, Counter

HDR = struct.Struct('<BIIBbHH')  # 15 bytes, no padding
LITEON_OUI = bytes.fromhex('506f9a')
# DeFlockJoplin's drive-tested primary Flock probe fingerprint (from flock-you).
FLOCK_PRIMARY_SIG = '2,12,127,221:506f9a16030103,45,191,221:0050f208000000'


def load_oui():
    """Optional offline vendor lookup from the app's shipped oui.txt."""
    table = {}
    for cand in ('../../app/public/oui.txt', 'app/public/oui.txt', 'oui.txt'):
        p = os.path.join(os.path.dirname(__file__), cand)
        if os.path.exists(p):
            with open(p, encoding='utf-8', errors='replace') as f:
                for line in f:
                    parts = line.strip().split('\t')
                    if len(parts) >= 2 and len(parts[0]) == 6:
                        table[parts[0].upper()] = parts[1]
            break
    return table


def parse_records(path):
    recs = []
    with open(path, 'rb') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith(b'#'):
                continue
            try:
                blob = base64.b64decode(line)
            except Exception:
                continue
            if len(blob) < HDR.size:
                continue
            radio, seq, ts, ch, rssi, olen, clen = HDR.unpack(blob[:HDR.size])
            payload = blob[HDR.size:HDR.size + clen]
            recs.append(dict(radio=radio, seq=seq, ts=ts, ch=ch, rssi=rssi,
                             orig_len=olen, cap_len=clen, payload=payload))
    return recs


def mac_str(b):
    return ':'.join('%02x' % x for x in b)


def is_local(mac6):
    return bool(mac6[0] & 0x02)   # locally-administered / randomized MAC


def parse_ies(body):
    """Yield (tag_id, data_bytes) from an 802.11 IE list."""
    i = 0
    while i + 2 <= len(body):
        tag, ln = body[i], body[i + 1]
        if i + 2 + ln > len(body):
            break
        yield tag, body[i + 2:i + 2 + ln]
        i += 2 + ln


def ie_signature(body):
    """Build the flock-you-style IE tag signature: skip SSID, vendor IEs as
    221:<up-to-8 payload bytes hex>, others as the tag number."""
    parts = []
    for tag, data in parse_ies(body):
        if tag == 0:
            continue
        if tag == 221:
            parts.append('221:' + data[:8].hex())
        else:
            parts.append(str(tag))
    return ','.join(parts)


def wifi_device(payload):
    """Return (addr2, subtype, ssid, ie_sig, has_liteon) or None."""
    if len(payload) < 24:
        return None
    ftype = (payload[0] >> 2) & 3
    fsub = (payload[0] >> 4) & 0xf
    addr2 = payload[10:16]
    if ftype != 0:                     # only mgmt frames carry IEs / identity
        return (addr2, fsub, None, None, False)
    body_off = 24 if fsub == 4 else 36  # probe req vs beacon/probe-resp fixed params
    body = payload[body_off:]
    ssid = None
    has_liteon = False
    for tag, data in parse_ies(body):
        if tag == 0 and data:
            try:
                ssid = data.decode('utf-8', 'replace')
            except Exception:
                ssid = None
        if tag == 221 and data[:3] == LITEON_OUI:
            has_liteon = True
    return (addr2, fsub, ssid, ie_signature(body), has_liteon)


SUBTYPE = {4: 'probe-req', 5: 'probe-resp', 8: 'beacon', 0: 'assoc-req',
           11: 'auth', 12: 'deauth', 13: 'action'}


def summarize(recs, oui):
    wifi = [r for r in recs if r['radio'] == 0]
    ble = [r for r in recs if r['radio'] == 1]

    # Sequence-gap based loss estimate, per radio.
    def gaps(rs):
        seqs = sorted(r['seq'] for r in rs)
        return (seqs[-1] - seqs[0] + 1 - len(seqs)) if seqs else 0

    print('=' * 70)
    print('CAPTURE SUMMARY')
    print('  WiFi frames: %d   BLE adverts: %d' % (len(wifi), len(ble)))
    print('  seq gaps (lost in transit): wifi=%d ble=%d' % (gaps(wifi), gaps(ble)))
    chans = Counter(r['ch'] for r in wifi if r['ch'])
    if chans:
        print('  WiFi channels seen: ' + ', '.join('%d(%d)' % (c, n) for c, n in sorted(chans.items())))

    # --- WiFi devices by transmitter MAC ---
    dev = defaultdict(lambda: dict(rssi=-999, subs=Counter(), ssids=set(),
                                   sig=None, liteon=False, n=0))
    for r in wifi:
        info = wifi_device(r['payload'])
        if not info:
            continue
        addr2, fsub, ssid, sig, liteon = info
        d = dev[bytes(addr2)]
        d['rssi'] = max(d['rssi'], r['rssi'])
        d['subs'][SUBTYPE.get(fsub, fsub)] += 1
        d['n'] += 1
        if ssid:
            d['ssids'].add(ssid)
        if sig:
            d['sig'] = sig
        if liteon:
            d['liteon'] = True

    print('\n' + '=' * 70)
    print('WiFi TRANSMITTERS (strongest first -- closest is likely the target)')
    for mac, d in sorted(dev.items(), key=lambda kv: -kv[1]['rssi'])[:30]:
        v = oui.get(mac_str(mac).replace(':', '')[:6].upper(), '')
        flags = []
        if is_local(mac):
            flags.append('RANDOM-MAC')
        if d['liteon']:
            flags.append('LITE-ON-IE')
        tag = (' [' + ' '.join(flags) + ']') if flags else ''
        print('  %-17s %4d dBm  n=%-4d %-9s %s%s' % (
            mac_str(mac), d['rssi'], d['n'],
            v[:9] if v and not is_local(mac) else '',
            ','.join('%s:%d' % (k, n) for k, n in d['subs'].most_common(3)), tag))
        if d['ssids']:
            print('        SSIDs: ' + ', '.join(sorted(d['ssids'])[:5]))

    # --- The key view: group by IE fingerprint. Many random MACs sharing ONE
    #     fingerprint == one physical device rotating its MAC. That is the Flock
    #     signature the OUI detector is blind to. ---
    bysig = defaultdict(lambda: dict(macs=set(), rssi=-999, liteon=False, n=0))
    for mac, d in dev.items():
        if not d['sig']:
            continue
        s = bysig[d['sig']]
        s['macs'].add(mac)
        s['rssi'] = max(s['rssi'], d['rssi'])
        s['liteon'] = s['liteon'] or d['liteon']
        s['n'] += d['n']

    print('\n' + '=' * 70)
    print('WiFi FINGERPRINTS (probe/beacon IE tag signatures)')
    print('  Many random MACs + one fingerprint = one device rotating its MAC.')
    for sig, s in sorted(bysig.items(), key=lambda kv: -len(kv[1]['macs']))[:15]:
        flock = ' <<< MATCHES FLOCK PRIMARY SIG' if sig == FLOCK_PRIMARY_SIG else ''
        lite = ' [LITE-ON]' if s['liteon'] else ''
        print('  %3d MACs  %4d dBm  n=%-5d %s%s' % (len(s['macs']), s['rssi'], s['n'], lite, flock))
        print('        sig: ' + (sig[:110] + ('…' if len(sig) > 110 else '')))

    # --- BLE ---
    bd = defaultdict(lambda: dict(rssi=-999, names=set(), comps=set(), uuids=set(), n=0))
    for r in ble:
        p = r['payload']
        if len(p) < 7:
            continue
        mac = mac_str(p[0:6])
        b = bd[mac]
        b['rssi'] = max(b['rssi'], r['rssi'])
        b['n'] += 1
        adv = p[7:]
        i = 0
        while i + 2 <= len(adv):
            ln = adv[i]
            if ln == 0 or i + 1 + ln > len(adv):
                break
            t = adv[i + 1]
            val = adv[i + 2:i + 1 + ln]
            if t in (0x08, 0x09):          # shortened / complete local name
                b['names'].add(val.decode('utf-8', 'replace'))
            elif t == 0xFF and len(val) >= 2:  # manufacturer data -> company id
                b['comps'].add('%02X%02X' % (val[1], val[0]))
            elif t in (0x02, 0x03) and len(val) >= 2:  # 16-bit service UUIDs
                b['uuids'].add('%02x%02x' % (val[1], val[0]))
            i += 1 + ln

    print('\n' + '=' * 70)
    print('BLE ADVERTISERS (strongest first)')
    for mac, b in sorted(bd.items(), key=lambda kv: -kv[1]['rssi'])[:20]:
        extra = []
        if b['names']:
            extra.append('name=' + '/'.join(sorted(b['names'])[:2]))
        if b['comps']:
            extra.append('company=' + ','.join(sorted(b['comps'])))
        if b['uuids']:
            extra.append('uuid=' + ','.join(sorted(b['uuids'])[:4]))
        print('  %-17s %4d dBm  n=%-4d %s' % (mac, b['rssi'], b['n'], '  '.join(extra)))

    # --- Verdict ---
    print('\n' + '=' * 70)
    print('VERDICT')
    liteon_sigs = [s for s, v in bysig.items() if v['liteon']]
    flock_hit = FLOCK_PRIMARY_SIG in bysig
    if flock_hit:
        print('  *** A device matches the known Flock probe fingerprint. ***')
    elif liteon_sigs:
        n_macs = sum(len(bysig[s]['macs']) for s in liteon_sigs)
        print('  50:6f:9a vendor IE (Wi-Fi Alliance; common on consumer WiFi) on %d'
              ' MAC(s) across %d fingerprint(s).' % (n_macs, len(liteon_sigs)))
        print('  Not proof -- even the full 16:03:01:03 payload rides consumer')
        print('  modules. Only a strong random-MAC cluster at the pole is interesting;')
        print('  compare its fingerprint above to the Flock primary sig.')
    else:
        print('  No Lite-On / Flock WiFi fingerprint seen. If you were next to a')
        print('  camera, it is likely silent on 2.4GHz WiFi and BLE (5GHz or LTE),')
        print('  which this hardware cannot hear.')
    return dev, bysig


def diff(near, far):
    near_dev, near_sig = near
    far_sigs = set(far[1].keys())
    print('\n' + '=' * 70)
    print('DIFF: fingerprints present NEAR but not FAR (candidates local to the site)')
    only = [(s, v) for s, v in near_sig.items() if s not in far_sigs]
    for sig, v in sorted(only, key=lambda kv: -kv[1]['rssi'])[:15]:
        print('  %3d MACs  %4d dBm %s' % (len(v['macs']), v['rssi'],
              '[LITE-ON]' if v['liteon'] else ''))
        print('        sig: ' + sig[:110])
    if not only:
        print('  (nothing unique -- move farther away for the FAR capture)')


def write_pcap(recs, out):
    """WiFi frames -> radiotap pcap (DLT 127) so Wireshark shows channel + RSSI."""
    DLT_IEEE802_11_RADIO = 127
    with open(out, 'wb') as f:
        f.write(struct.pack('<IHHiIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, DLT_IEEE802_11_RADIO))
        for r in recs:
            if r['radio'] != 0:
                continue
            # Minimal radiotap: present = flags? we expose channel + dBm signal.
            # present bitmap: bit3=Channel(4B: freq u16 + flags u16), bit5=dBm signal(1B)
            freq = 2407 + 5 * r['ch'] if r['ch'] else 2412
            rt = struct.pack('<BBH I', 0, 0, 0, (1 << 3) | (1 << 5))
            rt += struct.pack('<HH', freq, 0x00a0)   # channel freq + flags(2.4GHz)
            rt += struct.pack('<b', r['rssi'])        # antenna signal dBm
            rt = rt[:2] + struct.pack('<H', len(rt)) + rt[4:]  # patch it_len
            pkt = rt + r['payload']
            f.write(struct.pack('<IIII', r['ts'] // 1000000, r['ts'] % 1000000,
                                len(pkt), len(pkt)))
            f.write(pkt)
    print('Wrote WiFi frames to %s (open in Wireshark)' % out)


def selftest():
    # Build a synthetic Flock-style probe request record and assert it parses.
    # 802.11 probe req: FC=0x40 0x00, dur, addr1=bcast, addr2=random, addr3=bcast,
    # seq, then IEs: SSID(len0 wildcard) + Lite-On vendor IE with the sig payload.
    frame = bytes([0x40, 0x00, 0, 0]) + b'\xff' * 6 + bytes.fromhex('6a03ca5b7777') + \
        b'\xff' * 6 + bytes([0, 0]) + \
        bytes([0, 0]) + bytes([221, 7, 0x50, 0x6f, 0x9a, 0x16, 0x03, 0x01, 0x03])
    info = wifi_device(frame)
    addr2, fsub, ssid, sig, liteon = info
    assert mac_str(addr2) == '6a:03:ca:5b:77:77', mac_str(addr2)
    assert fsub == 4
    assert liteon is True
    assert is_local(addr2) is True
    assert '221:506f9a16030103' in sig, sig
    # Round-trip a full record through the on-wire format.
    rec = HDR.pack(0, 1, 12345, 6, -30, len(frame), len(frame)) + frame
    line = base64.b64encode(rec)
    blob = base64.b64decode(line)
    radio, seq, ts, ch, rssi, olen, clen = HDR.unpack(blob[:HDR.size])
    assert (radio, ch, rssi, olen) == (0, 6, -30, len(frame)), (radio, ch, rssi, olen)
    print('selftest: OK')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('capture', nargs='?', help='the .sscap file to analyze')
    ap.add_argument('--minus', help='a second .sscap (walked away); show what is only near')
    ap.add_argument('--pcap', help='write WiFi frames to this pcap for Wireshark')
    ap.add_argument('--selftest', action='store_true', help='run the parser self-check and exit')
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return
    if not args.capture:
        ap.error('give a .sscap file (or --selftest)')

    oui = load_oui()
    recs = parse_records(args.capture)
    if not recs:
        print('No records parsed from', args.capture)
        return
    near = summarize(recs, oui)
    if args.minus:
        far = summarize(parse_records(args.minus), oui)
        diff(near, far)
    if args.pcap:
        write_pcap(recs, args.pcap)


if __name__ == '__main__':
    main()
