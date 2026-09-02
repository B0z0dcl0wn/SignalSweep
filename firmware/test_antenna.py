"""Side-by-side antenna comparison for two SignalSweep boards.

Reads the 1 Hz USB-serial telemetry mirror from both boards at once and compares
what each one HEARS. Needs a build with the report gate open:

    set PLATFORMIO_BUILD_FLAGS=-D CONF_LIST_MIN=0   (then flash BOTH boards)
    python test_antenna.py COM3 COM4 [seconds]

The headline number is the paired median: for every MAC both boards heard, the
per-MAC RSSI difference. Pairing cancels out the environment, so it survives a
noisy room in a way that comparing raw averages does not.

ponytail: RSSI is the ESP32's own uncalibrated estimate, so treat the delta as
relative-between-these-two-boards only, never as an absolute dBm figure.
"""
import json
import statistics
import sys
import threading
import time
from collections import defaultdict

import serial

def collect(port, duration, out):
    samples = defaultdict(list)
    pushes = 0
    try:
        with serial.Serial(port, 115200, timeout=1) as ser:
            ser.reset_input_buffer()
            end = time.monotonic() + duration
            while time.monotonic() < end:
                line = ser.readline().decode("utf-8", "replace").strip()
                if not line.startswith("{"):
                    continue          # boot log / ESP_LOG noise
                try:
                    doc = json.loads(line)
                except json.JSONDecodeError:
                    continue          # truncated line, next push covers it
                if doc.get("status") != "success":
                    continue
                pushes += 1
                for t in doc.get("targets", []):
                    if "mac" in t and "rssi" in t:
                        samples[t["mac"]].append(t["rssi"])
    except serial.SerialException as e:
        out[port] = ("error", str(e))
        return
    out[port] = ("ok", samples, pushes)


def main():
    args = [a for a in sys.argv[1:]]
    duration = 60.0
    if args and args[-1].replace(".", "", 1).isdigit():
        duration = float(args.pop())
    if len(args) != 2:
        sys.exit("usage: test_antenna.py COM3 COM4 [seconds]")
    a, b = args

    print(f"Reading {a} and {b} for {duration:.0f}s. Keep both boards still,")
    print("same orientation, a hand-width apart, nothing between them and the room.")
    out = {}
    threads = [threading.Thread(target=collect, args=(p, duration, out)) for p in (a, b)]
    for t in threads: t.start()
    for t in threads: t.join()

    for p in (a, b):
        if out.get(p, ("error", "no data"))[0] == "error":
            sys.exit(f"{p}: {out.get(p, ('', 'no result'))[1]}")

    _, sa, pa = out[a]
    _, sb, pb = out[b]
    print(f"\n{'port':<10}{'pushes':>8}{'unique MACs':>13}{'median RSSI':>13}")
    for p, s, n in ((a, sa, pa), (b, sb, pb)):
        med = statistics.median([r for v in s.values() for r in v]) if s else float("nan")
        print(f"{p:<10}{n:>8}{len(s):>13}{med:>13.1f}")

    if not sa or not sb:
        sys.exit("\nOne board heard nothing -- is it flashed with CONF_LIST_MIN=0?")

    both = set(sa) & set(sb)
    only_a, only_b = set(sa) - set(sb), set(sb) - set(sa)
    print(f"\nheard by both: {len(both)}   only {a}: {len(only_a)}   only {b}: {len(only_b)}")
    if not both:
        sys.exit("No shared devices -- run longer or move somewhere with more BLE traffic.")

    deltas = [statistics.median(sa[m]) - statistics.median(sb[m]) for m in both]
    d = statistics.median(deltas)
    print(f"paired median delta: {d:+.1f} dB  ({a} minus {b}, n={len(both)})")
    better, worse = (a, b) if d > 0 else (b, a)
    if abs(d) < 3:
        print(f"Under 3 dB -- inside placement noise. No real difference shown.")
    else:
        print(f"{better} hears {abs(d):.1f} dB stronger than {worse}.")
    # Reach matters more than loudness: a board that hears devices the other
    # one never sees at all is the actual antenna win.
    print(f"reach: {a} heard {len(only_a)} device(s) {b} missed entirely; {b} heard {len(only_b)} that {a} missed.")


if __name__ == "__main__":
    main()
