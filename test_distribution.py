#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Distribution contract: the flasher manifest, partitions.csv, install.py and
the flasher page must agree. A wrong offset here bricks a board until it is
reflashed, and nothing else would notice before a user does.

  python test_distribution.py
"""
import csv
import json
import re
from pathlib import Path

import install

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "site/manifest.json").read_text())
CHIP_FAMILY = {"s3": "ESP32-S3", "c5": "ESP32-C5"}
BOOTLOADER = {"s3": 0x0, "c5": 0x2000}


def partition_offset(name):
    for row in csv.reader((ROOT / "firmware/partitions.csv").read_text().splitlines()):
        if row and not row[0].startswith("#") and row[0].strip() == name:
            return int(row[3].strip(), 16)
    raise AssertionError(f"partitions.csv has no {name} row")


def main():
    builds = {b["chipFamily"]: b for b in MANIFEST["builds"]}
    assert set(install.BOARDS) == {"s3", "c5"}, sorted(install.BOARDS)
    for board, fam in CHIP_FAMILY.items():
        assert fam in builds, f"manifest has no {fam} build"
        manifest_parts = [(Path(p["path"]).name, p["offset"]) for p in builds[fam]["parts"]]
        assert manifest_parts == install.BOARDS[board]["parts"], \
            f"{board}: manifest {manifest_parts} != install.py {install.BOARDS[board]['parts']}"
        offsets = dict((n.removeprefix("c5-"), o) for n, o in manifest_parts)
        assert offsets["bootloader.bin"] == BOOTLOADER[board], f"{board} bootloader at {offsets['bootloader.bin']:#x}"
        assert offsets["partitions.bin"] == 0x8000
        assert offsets["boot_app0.bin"] == partition_offset("otadata"), f"{board} boot_app0"
        assert offsets["signalsweep.bin"] == partition_offset("app0"), f"{board} app"
        prefix = "" if board == "s3" else "c5-"
        assert all(n.startswith(prefix) for n, _ in manifest_parts), f"{board} asset names"
        if board == "s3":
            assert not any(n.startswith("c5-") for n, _ in manifest_parts), \
                "s3 asset names must not carry the c5- prefix"

    html = (ROOT / "site/index.html").read_text(encoding="utf-8")
    assert re.search(r"esp-web-tools@\d+\.\d+\.\d+/", html), "flasher script is not pinned to an exact version"

    parse = install.board_from_chip_output
    assert parse("Chip type:          ESP32-C5 (QFN32) (revision v1.0)") == "c5"   # esptool 5
    assert parse("Chip is ESP32-S3 (QFN56) (revision v0.2)") == "s3"              # esptool 4
    assert parse("Chip type:          ESP32-C3 (QFN32)") is None
    assert parse("A fatal error occurred: Failed to connect") is None
    print("PASS")


if __name__ == "__main__":
    main()
