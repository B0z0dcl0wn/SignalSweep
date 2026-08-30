#!/usr/bin/env python3
"""Build + flash SignalSweep firmware for a given hardware tier.

One codebase, one PlatformIO env per tier (see firmware/platformio.ini):
  tier1  cheap off-the-shelf, phone UI, external U.FL antenna  (ships today)
  tier2  + screen, battery, second radio
  tier3  + onboard GPS, buttons, logging

Usage:
  python flash.py                 # tier1 (default)
  python flash.py --tier 2
  python flash.py --port COM3
  python flash.py --auto          # pick tier from the board (Tier 2+; stub today)

ponytail: --auto is a stub until Tier 2 boards ship a hardware ID (an ADC
ID-resistor, or the NVS "tier" key the firmware already writes, read back over
serial). Until then it falls through to tier1.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

FIRMWARE = Path(__file__).resolve().parent / "firmware"
PIO_INI = FIRMWARE / "platformio.ini"


def envs_in_ini():
    return set(re.findall(r"^\[env:([^\]]+)\]", PIO_INI.read_text(), re.MULTILINE))


def pio_cmd():
    # Prefer `pio` on PATH; fall back to `python -m platformio` (same tool).
    from shutil import which
    return ["pio"] if which("pio") else [sys.executable, "-m", "platformio"]


def main():
    ap = argparse.ArgumentParser(description="Flash SignalSweep firmware by tier.")
    ap.add_argument("--tier", type=int, choices=[1, 2, 3], default=1)
    ap.add_argument("--port", help="upload port, e.g. COM3 (auto-detected if omitted)")
    ap.add_argument("--auto", action="store_true",
                    help="pick tier from the board (Tier 2+; stub -> tier1 today)")
    args = ap.parse_args()

    tier = args.tier
    if args.auto:
        print("[flash] --auto: board auto-ID not wired until Tier 2; using tier1.")
        tier = 1

    env = f"tier{tier}"
    available = envs_in_ini()
    assert env in available, f"env '{env}' not in platformio.ini (have: {sorted(available)})"

    cmd = pio_cmd() + ["run", "-e", env, "-t", "upload", "-d", str(FIRMWARE)]
    if args.port:
        cmd += ["--upload-port", args.port]

    print(f"[flash] {' '.join(cmd)}")
    sys.exit(subprocess.call(cmd))


if __name__ == "__main__":
    main()
