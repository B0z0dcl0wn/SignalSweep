#!/usr/bin/env python3
"""Read the alert log off a SignalSweep board over USB.

The board records every alert its buzzer sounded (alert_log.h): 16-byte fixed
records in a wrapping ring on LittleFS, plus a rule-name table. This pulls them
back and prints them, which is the bench witness that headless logging works --
the same job app/public/app.js does on the phone.

  python read-log.py --port COM3
  python read-log.py --port COM3 --from-boot 7 --from-secs 0
  python read-log.py --port COM3 --stat
  python read-log.py --port COM3 --clear
  python read-log.py --port COM3 --on | --off
"""

import argparse
import base64
import json
import struct
import sys
import time

import serial

REC = 16
CATS = ["ALPR/Camera", "Body cam", "Drone", "Tracker", "Other"]


def drain(ser, seconds):
    """Collect decoded lines for `seconds`, ignoring the 1 Hz telemetry push."""
    out = []
    end = time.time() + seconds
    buf = b""
    while time.time() < end:
        buf += ser.read(4096)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            out.append(line.decode("utf-8", "replace").strip())
    return out


def send(ser, cmd, wait=1.5):
    ser.reset_input_buffer()
    ser.write((cmd + "\n").encode())
    ser.flush()
    return drain(ser, wait)


def cfg(ser):
    for line in send(ser, "CMD:CFG"):
        if '"cfg"' in line:
            try:
                return json.loads(line)
            except ValueError:
                pass
    return None


def read_page(ser, boot, secs, skip, wait):
    """One CMD:LOG:READ page -> (records, names, more)."""
    lines = send(ser, f"CMD:LOG:READ:{boot}:{secs}:{skip}", wait)
    recs, names, more, hdr_seen = [], None, False, False
    for line in lines:
        if line.startswith("LOG:"):
            try:
                recs.append(base64.b64decode(line[4:]))
            except Exception:
                pass
        elif '"logrd"' in line:
            try:
                o = json.loads(line)["logrd"]
            except ValueError:
                continue
            if "names" in o:
                names = [n for n in o["names"].split("\n") if n]
            if "more" in o:
                more, hdr_seen = bool(o["more"]), True
            if o.get("err"):
                print(f"  board error: {o['err']}", file=sys.stderr)
    blob = b"".join(recs)
    return [blob[i:i + REC] for i in range(0, len(blob) - REC + 1, REC)], names, (more and hdr_seen)


def decode(rec):
    boot, secs = struct.unpack_from("<HI", rec, 0)
    mac = ":".join(f"{b:02x}" for b in rec[6:12])
    cat, rule, rssi = rec[12], rec[13], struct.unpack_from("<b", rec, 14)[0]
    return boot, secs, mac, cat, rule, rssi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", required=True)
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--from-boot", type=int, default=0)
    ap.add_argument("--from-secs", type=int, default=0)
    ap.add_argument("--wait", type=float, default=3.0, help="seconds to collect per page")
    ap.add_argument("--stat", action="store_true")
    ap.add_argument("--clear", action="store_true")
    ap.add_argument("--on", action="store_true")
    ap.add_argument("--off", action="store_true")
    ap.add_argument("--quiet", action="store_true",
                    help="mute the buzzer for the run and restore it afterwards. "
                         "A bench run that reboots the board repeatedly otherwise "
                         "beeps on every boot -- the detector working correctly, and "
                         "still unbearable in the same room.")
    a = ap.parse_args()

    # Opening the port resets the board; wait for it to come back up.
    with serial.Serial(a.port, a.baud, timeout=0.2) as ser:
        time.sleep(2.0)

        if a.on:
            send(ser, "CMD:LOG:ON")
        if a.off:
            send(ser, "CMD:LOG:OFF")
        if a.clear:
            send(ser, "CMD:LOG:CLEAR")
            print("log cleared")

        c = cfg(ser)
        if c is None:
            print("no CMD:CFG reply -- is the board running this firmware?", file=sys.stderr)
            return 1

        # The mute persists in NVS, so a script that died holding it would leave a
        # board that boots silent -- indistinguishable from a broken buzzer, on a
        # device whose buzzer IS the interface. Restore whatever it was, in a
        # finally, and say so loudly if that could not be confirmed.
        prev_buzzer = None
        if a.quiet:
            prev_buzzer = bool(c.get("buzzer", True))
            send(ser, '{"buzzer":false}')
            print("buzzer muted for this run")
        try:
            return report(ser, a, c)
        finally:
            if prev_buzzer is not None:
                send(ser, '{"buzzer":%s}' % ("true" if prev_buzzer else "false"))
                back = cfg(ser)
                if back is None or bool(back.get("buzzer")) != prev_buzzer:
                    print("WARNING: buzzer restore unconfirmed -- run: "
                          f"python read-log.py --port {a.port} --stat", file=sys.stderr)
                else:
                    print("buzzer restored to %s" % ("ON" if prev_buzzer else "OFF"))


def report(ser, a, c):
        print(f"board   : {c.get('ble_name')}  uptime {c.get('uptime')}s  alerts {c.get('alerts')}")
        print(f"logging : {'ON' if c.get('log') else 'OFF'}   held {c.get('log_n')} records"
              f"   now at boot {c.get('log_boot')} secs {c.get('log_secs')}")
        if a.stat or a.clear or a.on or a.off:
            return 0

        all_recs, names, skip = [], None, 0
        while True:
            page, pnames, more = read_page(ser, a.from_boot, a.from_secs, skip, a.wait)
            if pnames is not None:
                names = pnames
            all_recs += page
            if not more or not page:
                break
            skip += len(page)

        if not all_recs:
            print("\nno records in range")
            return 0

        print(f"\n{len(all_recs)} records"
              + (f", {len(names)} rule names" if names else ""))
        print(f"{'boot':>5} {'secs':>8}  {'mac':<17} {'category':<12} {'rssi':>5}  rule")
        for r in all_recs:
            boot, secs, mac, cat, rule, rssi = decode(r)
            cname = CATS[cat] if cat < len(CATS) else f"?{cat}"
            rname = names[rule] if (names and rule < len(names)) else ""
            print(f"{boot:>5} {secs:>8}  {mac:<17} {cname:<12} {rssi:>5}  {rname}")

        # The ordering key must never go backwards: it is what lets the board
        # derive its ring head instead of storing one.
        keys = [(struct.unpack_from("<HI", r, 0)) for r in all_recs]
        bad = [i for i in range(1, len(keys)) if keys[i] < keys[i - 1]]
        print(f"\nordering: {'OK' if not bad else f'BROKEN at {bad[:5]}'}")
        return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
