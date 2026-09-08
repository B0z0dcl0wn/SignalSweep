"""Side-by-side antenna comparison for two SignalSweep boards.

Reads the 1 Hz USB-serial telemetry mirror from both boards at once and compares
what each one HEARS -- and, because each board advertises "SignalSweep" while the
other is scanning, what each one TRANSMITS.

    python test_antenna.py COM3 COM4 [seconds] [--label "1-flat"]

The script sends {"scan_all":true} on open, which opens the *listing* gate at
runtime -- no reflash. (The old route, a -D CONF_LIST_MIN=0 build on both boards,
still works and is not needed.) NOTE scan_all persists in NVS; send
{"scan_all":false} when you are done or the board comes back unfiltered.

The headline number is the paired median: for every MAC both boards heard, the
per-MAC RSSI difference. Pairing cancels out the environment, so it survives a
noisy room in a way that comparing raw averages does not.

For an orientation sweep, leave one board bolted down as the reference and move
only the other, one run per orientation, and compare the deltas run-to-run.

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

SELF_NAME = "SignalSweep"   # what a board calls itself on the air


def collect(port, duration, out):
    samples = defaultdict(list)
    names = {}
    pushes = 0
    try:
        with serial.Serial(port, 115200, timeout=1) as ser:
            ser.reset_input_buffer()
            # Open the report gate at runtime instead of reflashing for it.
            ser.write(b'{"scan_all":true}\n')
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
                        if t.get("name"):
                            names[t["mac"]] = t["name"]
    except serial.SerialException as e:
        out[port] = ("error", str(e))
        return
    out[port] = ("ok", samples, pushes, names)


def heard_peer(samples, names):
    """Every RSSI sample from a target calling itself SignalSweep.

    Keyed by name, not MAC: the peer may be advertising a rotating random
    address, in which case its MAC changes under us mid-run.
    """
    return [r for mac, n in names.items()
            if n.startswith(SELF_NAME) for r in samples[mac]]


def main():
    args = sys.argv[1:]
    label = ""
    if "--label" in args:
        i = args.index("--label")
        label = args[i + 1] if i + 1 < len(args) else ""
        del args[i:i + 2]
    duration = 60.0
    if args and args[-1].replace(".", "", 1).isdigit():
        duration = float(args.pop())
    if len(args) != 2:
        sys.exit('usage: test_antenna.py COM3 COM4 [seconds] [--label "name"]')
    a, b = args

    if label:
        print(f"=== run: {label} ===")
    print(f"Reading {a} and {b} for {duration:.0f}s. Keep the reference board still;")
    print("move only the board under test, and stay out from between them.")
    out = {}
    threads = [threading.Thread(target=collect, args=(p, duration, out)) for p in (a, b)]
    for t in threads: t.start()
    for t in threads: t.join()

    for p in (a, b):
        if out.get(p, ("error", "no data"))[0] == "error":
            sys.exit(f"{p}: {out.get(p, ('', 'no result'))[1]}")

    _, sa, pa, na = out[a]
    _, sb, pb, nb = out[b]
    print(f"\n{'port':<10}{'pushes':>8}{'unique MACs':>13}{'median RSSI':>13}")
    for p, s, n in ((a, sa, pa), (b, sb, pb)):
        med = statistics.median([r for v in s.values() for r in v]) if s else float("nan")
        print(f"{p:<10}{n:>8}{len(s):>13}{med:>13.1f}")

    if not sa or not sb:
        sys.exit("\nOne board heard nothing -- did scan_all take? Check the raw push.")

    both = set(sa) & set(sb)
    only_a, only_b = set(sa) - set(sb), set(sb) - set(sa)
    print(f"\nheard by both: {len(both)}   only {a}: {len(only_a)}   only {b}: {len(only_b)}")
    if not both:
        sys.exit("No shared devices -- run longer or move somewhere with more BLE traffic.")

    deltas = [statistics.median(sa[m]) - statistics.median(sb[m]) for m in both]
    d = statistics.median(deltas)
    print(f"RX paired median delta: {d:+.1f} dB  ({a} minus {b}, n={len(both)})")
    better, worse = (a, b) if d > 0 else (b, a)
    if abs(d) < 3:
        print("Under 3 dB -- inside placement noise. No real difference shown.")
    else:
        print(f"{better} hears {abs(d):.1f} dB stronger than {worse}.")
    # Reach matters more than loudness: a board that hears devices the other
    # one never sees at all is the actual antenna win.
    print(f"reach: {a} heard {len(only_a)} device(s) {b} missed entirely; {b} heard {len(only_b)} that {a} missed.")

    # TX: each board's own advertisement, as measured by the other. Reciprocity
    # says this should track the RX delta -- if it does not, something in the
    # setup moved between the two measurements.
    print("\nTX (each board's advert as heard by the other):")
    for tx, rx, s, n in ((a, b, sb, nb), (b, a, sa, na)):
        v = heard_peer(s, n)
        if v:
            print(f"  {tx} transmit, measured at {rx}: {statistics.median(v):>6.1f} dBm  (n={len(v)})")
        else:
            print(f"  {tx} transmit: not heard by {rx} -- out of range, or {tx} is in receive-only.")


if __name__ == "__main__":
    main()
