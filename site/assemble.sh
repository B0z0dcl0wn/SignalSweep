#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Assembles the published site. Split into modes because building the C5 in its
# own PlatformIO core dir wipes firmware/.pio/build: stage each board's images
# right after its own build, before the next one runs. CI and a local bench run
# use this same script, so what the bench flashes is what Pages serves.
#
#   bash site/assemble.sh s3     # after: pio run -e tier1
#   bash site/assemble.sh c5     # after: PLATFORMIO_CORE_DIR=... pio run -e c5
#   bash site/assemble.sh site   # after: app build; copies site + app, checks parts
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=_site/firmware
mkdir -p "$OUT"

stage() {  # stage <env> <prefix> <core dir>
  local B="firmware/.pio/build/$1"
  cp "$B/bootloader.bin" "$OUT/$2bootloader.bin"
  cp "$B/partitions.bin" "$OUT/$2partitions.bin"
  cp "$B/firmware.bin"   "$OUT/$2signalsweep.bin"
  # boot_app0.bin ships with the Arduino framework package, not the build.
  # -print -quit, not "| head -1": under pipefail head's early exit can SIGPIPE
  # find and fail a clean run. The core dir holds one framework version (the
  # platform is pinned and CI caches have no restore-keys), so first is the one.
  local BA
  BA=$(find "$3/packages" -path '*framework-arduinoespressif32*' -name boot_app0.bin -print -quit)
  test -n "$BA" || { echo "boot_app0.bin not found under $3"; exit 1; }
  cp "$BA" "$OUT/$2boot_app0.bin"
  echo "staged $1 -> $OUT/$2*"
}

case "${1:-}" in
  s3) stage tier1 "" "${PLATFORMIO_CORE_DIR:-$HOME/.platformio}" ;;
  c5) stage c5 "c5-" "${PLATFORMIO_CORE_DIR:?set PLATFORMIO_CORE_DIR to the C5 core dir}" ;;
  site)
    cp site/index.html site/manifest.json site/favicon.svg _site/
    rm -rf _site/app && cp -r app/dist _site/app
    # Fail loudly if the manifest references a file we did not produce.
    python - <<'PY'
import json, pathlib, sys
m = json.load(open('site/manifest.json'))
missing = [p['path'] for b in m['builds'] for p in b['parts']
           if not pathlib.Path('_site', p['path']).is_file()]
if missing:
    sys.exit('manifest references missing files: ' + ', '.join(missing))
print('manifest parts all present')
PY
    ;;
  *) echo "usage: $0 s3|c5|site"; exit 2 ;;
esac
