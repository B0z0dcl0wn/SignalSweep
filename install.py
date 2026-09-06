#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
"""Install SignalSweep from a published release: firmware, app, or both.

This is the *user* installer. It downloads prebuilt artifacts from a GitHub
release and puts them on hardware. It does not build anything and needs no
toolchain -- see flash.py for the developer path, which builds from source with
PlatformIO.

  python install.py                    # firmware + app, latest release
  python install.py --apk-only
  python install.py --esp-only
  python install.py --tag v0.1.0       # a specific release
  python install.py --erase            # also wipe saved settings (see below)
  python install.py --list             # show what is attached, change nothing

Requires: esptool (pip install esptool) for the firmware, adb on PATH for the
app. Only the one you actually use is checked.

Design notes, because this script points destructive tools at hardware:

  * It never guesses which device to touch. With more than one board or phone
    attached it lists them and makes you choose, and it always prints exactly
    what is about to happen before doing any of it.
  * --erase is opt-in. A chip erase wipes NVS, which on this project means the
    buzzer mute, the beep mask, the hunt target, the BLE name and the signature
    rules -- everything the operator set. The device is meant to be left
    running headless, so losing that silently would be the worst kind of bug.
  * Downloads are verified against the sha256 GitHub publishes for each asset
    before anything is flashed. A truncated firmware image bricks the board
    until it is reflashed, and a half-downloaded file is the likeliest way to
    get one.
  * An existing install signed with a different key is detected up front,
    because `adb install` reports it as INSTALL_FAILED_UPDATE_INCOMPATIBLE and
    the only fix -- uninstalling -- destroys the encrypted pin store.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REPO = "B0z0dcl0wn/SignalSweep"
API = f"https://api.github.com/repos/{REPO}/releases"
PKG = "com.signalsweep.app"

# Flash offsets come from firmware/partitions.csv and must match site/manifest.json.
PARTS = [
    ("bootloader.bin", 0x0),
    ("partitions.bin", 0x8000),
    ("boot_app0.bin", 0xE000),
    ("signalsweep.bin", 0x10000),
]

# Espressif's USB vendor id. The XIAO ESP32-S3 enumerates as native USB CDC.
ESP_VIDS = {0x303A, 0x10C4, 0x1A86, 0x0403}


def die(msg, code=1):
    print(f"\n[install] error: {msg}", file=sys.stderr)
    sys.exit(code)


def say(msg=""):
    print(msg, flush=True)


# --------------------------------------------------------------------------
#  Release download
# --------------------------------------------------------------------------
def fetch_release(tag=None):
    url = f"{API}/tags/{tag}" if tag else f"{API}/latest"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                               "User-Agent": "signalsweep-install"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            die(f"no release found{f' for tag {tag}' if tag else ''} in {REPO}")
        die(f"GitHub API returned {e.code} {e.reason}")
    except urllib.error.URLError as e:
        die(f"could not reach GitHub: {e.reason}")


def download(asset, dest_dir):
    """Fetch one asset and verify it against the digest GitHub publishes.

    The digest is the server's own record of what it stored, so a mismatch
    means the bytes changed in transit -- exactly the case that would
    otherwise be discovered by flashing a corrupt image to a board.
    """
    out = Path(dest_dir) / asset["name"]
    req = urllib.request.Request(asset["browser_download_url"],
                                 headers={"User-Agent": "signalsweep-install"})
    h = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=120) as r, open(out, "wb") as f:
        while chunk := r.read(65536):
            f.write(chunk)
            h.update(chunk)

    got = h.hexdigest()
    want = (asset.get("digest") or "").removeprefix("sha256:")
    size_ok = out.stat().st_size == asset["size"]

    if want:
        if got != want:
            die(f"{asset['name']}: sha256 mismatch\n"
                f"  expected {want}\n  got      {got}\n"
                "Refusing to continue -- the download is corrupt or tampered with.")
        mark = "sha256 ok"
    elif not size_ok:
        # Older releases predate the API's digest field; size is all we have.
        die(f"{asset['name']}: expected {asset['size']} bytes, got {out.stat().st_size}")
    else:
        mark = "size ok (no digest published)"

    say(f"    {asset['name']:<28} {out.stat().st_size/1024:8.1f} KB  {mark}")
    return out


# --------------------------------------------------------------------------
#  Device discovery
# --------------------------------------------------------------------------
def esp_ports():
    try:
        from serial.tools import list_ports
    except ImportError:
        die("pyserial is needed to find the board: pip install pyserial")
    found = []
    for p in list_ports.comports():
        if p.vid in ESP_VIDS or "CP210" in (p.description or "") or "CH340" in (p.description or ""):
            found.append(p)
    return found


def adb_devices(adb):
    # stdin=DEVNULL on every adb call: adb inherits the parent's stdin and
    # consumes it, which made the confirmation prompt read EOF instead of the
    # operator's answer. A helper process must not eat the installer's input.
    out = subprocess.run([adb, "devices", "-l"], capture_output=True, text=True,
                         stdin=subprocess.DEVNULL).stdout
    devs = []
    for line in out.splitlines()[1:]:
        line = line.strip()
        if not line or "\t" not in line and " " not in line:
            continue
        parts = line.split()
        serial, state = parts[0], parts[1]
        model = next((p.split(":", 1)[1] for p in parts if p.startswith("model:")), "?")
        devs.append({"serial": serial, "state": state, "model": model})
    return devs


def choose(items, label, fmt):
    """Never guess. One item is used; several must be picked; none is an error."""
    if not items:
        die(f"no {label} found")
    if len(items) == 1:
        return items[0]
    say(f"\nMore than one {label} attached:")
    for i, it in enumerate(items, 1):
        say(f"  [{i}] {fmt(it)}")
    while True:
        pick = input(f"Which {label}? [1-{len(items)}] ").strip()
        if pick.isdigit() and 1 <= int(pick) <= len(items):
            return items[int(pick) - 1]
        say("  not a valid choice")


# --------------------------------------------------------------------------
#  Actions
# --------------------------------------------------------------------------
def installed_signature(adb, serial):
    """Return the installed APK's signer digest, or None if not installed.

    Used to catch the upgrade that cannot work before adb reports it as a bare
    error code. Falls back to None (proceed, let adb speak) if the device's
    package manager does not support the query -- being unable to check is not
    a reason to refuse.
    """
    r = subprocess.run([adb, "-s", serial, "shell", "dumpsys", "package", PKG],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if PKG not in r.stdout:
        return None
    m = re.search(r"(?:signatures|Signature)\S*[=:]\s*\[?([0-9a-fA-F]{8,})", r.stdout)
    return m.group(1) if m else "unknown"


def flash_firmware(port, files, erase):
    cmd = [sys.executable, "-m", "esptool", "--chip", "esp32s3", "--port", port,
           "--baud", "921600", "write_flash", "-z"]
    if erase:
        # A write_flash sub-option, so it must come AFTER the subcommand.
        # Placed before it, esptool exits with "No such option: --erase-all"
        # and nothing is flashed -- which at least fails loudly, but the erase
        # the operator asked for silently would not have happened.
        cmd.append("--erase-all")
    for name, off in PARTS:
        cmd += [hex(off), str(files[name])]
    say(f"\n[install] {' '.join(str(c) for c in cmd)}\n")
    return subprocess.call(cmd)


def install_apk(adb, serial, apk):
    say(f"\n[install] {adb} -s {serial} install -r {apk}\n")
    r = subprocess.run([adb, "-s", serial, "install", "-r", str(apk)],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL)
    out = (r.stdout or "") + (r.stderr or "")
    say(out.strip())
    if "INSTALL_FAILED_UPDATE_INCOMPATIBLE" in out or "signatures do not match" in out:
        say("\nThe phone already has SignalSweep signed with a different key.")
        say("Uninstalling will DESTROY the encrypted pin store on that phone.")
        say(f"If you accept that: adb -s {serial} uninstall {PKG}")
        return 1
    return r.returncode


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Install SignalSweep firmware and/or the Android app from a release.")
    ap.add_argument("--tag", help="release tag, e.g. v0.1.0 (default: latest)")
    ap.add_argument("--esp-only", action="store_true", help="firmware only")
    ap.add_argument("--apk-only", action="store_true", help="Android app only")
    ap.add_argument("--port", help="serial port, e.g. COM3 (auto-detected if omitted)")
    ap.add_argument("--serial", help="adb device serial (auto-detected if omitted)")
    ap.add_argument("--erase", action="store_true",
                    help="chip-erase first: WIPES saved settings (mute, beep mask, "
                         "hunt target, BLE name, signature rules)")
    ap.add_argument("--list", action="store_true", help="show attached devices and exit")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    if args.esp_only and args.apk_only:
        die("--esp-only and --apk-only are mutually exclusive")
    do_esp = not args.apk_only
    do_apk = not args.esp_only

    adb = shutil.which("adb")

    if args.list:
        say("ESP32 boards:")
        for p in esp_ports():
            say(f"  {p.device:<8} {p.description}")
        say("\nADB devices:")
        if not adb:
            say("  (adb not on PATH)")
        else:
            for d in adb_devices(adb):
                say(f"  {d['serial']:<20} {d['model']:<20} {d['state']}")
        return 0

    # ---- pick targets before downloading anything -------------------------
    port = dev = None
    if do_esp:
        if args.port:
            port = args.port
        else:
            p = choose(esp_ports(), "ESP32 board",
                       lambda x: f"{x.device:<8} {x.description}")
            port = p.device
    if do_apk:
        if not adb:
            die("adb is not on PATH. Install Android platform-tools, or use --esp-only.")
        live = [d for d in adb_devices(adb) if d["state"] == "device"]
        unauth = [d for d in adb_devices(adb) if d["state"] == "unauthorized"]
        if unauth and not live:
            die("phone is connected but unauthorized -- accept the USB debugging "
                "prompt on the device, then re-run")
        if args.serial:
            dev = next((d for d in live if d["serial"] == args.serial), None)
            if not dev:
                die(f"no authorized adb device with serial {args.serial}")
        else:
            dev = choose(live, "phone",
                         lambda x: f"{x['serial']:<20} {x['model']}")

    rel = fetch_release(args.tag)
    version = rel["tag_name"].lstrip("v")
    assets = {a["name"]: a for a in rel["assets"]}

    apk_asset = next((a for n, a in assets.items() if n.lower().endswith(".apk")), None)
    if do_apk and not apk_asset:
        die(f"release {rel['tag_name']} has no APK attached.\n"
            "If this release predates APK publishing, try a newer tag, or use --esp-only.")
    if do_esp:
        missing = [n for n, _ in PARTS if n not in assets]
        if missing:
            die(f"release {rel['tag_name']} is missing firmware parts: {', '.join(missing)}")

    # ---- say exactly what is about to happen ------------------------------
    say("")
    say(f"  SignalSweep {rel['tag_name']}")
    say(f"  {rel['html_url']}")
    say("")
    say("  About to:")
    if do_esp:
        say(f"    - flash firmware to {port}")
        if args.erase:
            say("        WITH --erase: this WIPES saved settings on that board --")
            say("        buzzer mute, beep mask, hunt target, BLE name, signature rules.")
        else:
            say("        keeping saved settings (pass --erase for factory defaults)")
    if do_apk:
        say(f"    - install SignalSweep {version} to {dev['serial']} ({dev['model']})")
        sig = installed_signature(adb, dev["serial"])
        if sig:
            say(f"        {PKG} is already installed on this phone; it will be upgraded")
            say("        in place, keeping its data. If the signing keys differ the")
            say("        install will be refused rather than silently wiping anything.")
    say("")

    if not args.yes:
        want = (dev["serial"] if do_apk else port)
        got = input(f"  Type '{want}' to confirm, anything else to abort: ").strip()
        if got != want:
            say("  aborted, nothing changed")
            return 1

    # ---- download, verify, install ---------------------------------------
    with tempfile.TemporaryDirectory(prefix="signalsweep-") as tmp:
        say(f"\n[install] downloading {rel['tag_name']}")
        files = {}
        if do_esp:
            for name, _ in PARTS:
                files[name] = download(assets[name], tmp)
        apk = download(apk_asset, tmp) if do_apk else None

        if do_esp:
            try:
                import esptool  # noqa: F401
            except ImportError:
                die("esptool is needed to flash: pip install esptool")
            rc = flash_firmware(port, files, args.erase)
            if rc != 0:
                die(f"flashing failed (esptool exit {rc})", rc)
            say("[install] firmware flashed")

        if do_apk:
            rc = install_apk(adb, dev["serial"], apk)
            if rc != 0:
                die(f"app install failed (adb exit {rc})", rc)
            say("[install] app installed")

    say("\n[install] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
