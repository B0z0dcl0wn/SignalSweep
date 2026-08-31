# Changelog

All notable changes to SignalSweep are recorded here.

## [Unreleased] — 2026-08-31

### Added
- **Shadow mode** (mode 4) — tail / pursuit detection. The firmware harvests
  every BLE + Wi-Fi device it hears; the phone correlates each against its GPS
  trail and flags any that reappear near you across multiple distinct places
  (>200 m apart). Ranks devices "Watching" → "⚠ Following you" by how many
  separate places they've shadowed you.
  - **Whitelist** — tap a tail row to mark it as your own gear (car AP, phone,
    earbuds); it's hidden from scoring and persisted on the phone, so what
    remains flagged is genuinely foreign.
- **Watcher's Watch confidence scoring** — surveillance detections now carry a
  0–100 confidence and a Confirmed / Likely / Possible tier instead of a plain
  yes/no, with corroboration when a device is seen on both BLE and Wi-Fi.
- **Beacon Bandit stalking detection** — reads the Apple Find My
  "separated/offline" state and computes a per-device stalking score from
  persistence, sightings, and proximity; a "⚠ Stalking" badge surfaces likely
  trackers, and the locked-on target is pinned to the top of the list.
- **Tiered build system** — one codebase, one PlatformIO env per hardware tier
  (`tier1` ships today; `tier2`/`tier3` reserve seams for a screen/battery/second
  radio, then GPS/buttons). `flash.py --tier N` wraps the build+upload;
  `capabilities.h` gates hardware features; the compiled tier is stored in NVS.

### Changed
- **"Ring / Find" replaces the offensive path** — removed the BLE
  advertisement-spoofing engine (`ble_spoof`) entirely; the retained GATT write
  is reframed as a defensive action that rings a suspected tracker (Immediate
  Alert Service) so you can physically locate it. Arbitrary-hex GATT writes
  removed.
- **Fewer false positives in Watcher's Watch** — the Lite-On vendor IE
  (`50:6F:9A`) is treated as a weak, non-Flock-specific hint, and the listing
  floor was raised so a single weak signal no longer reports a device; a match
  needs a Flock/Axon-specific signal or two corroborating ones.
- **Sky Sweeper** and the Wi-Fi hoppers now sweep all 2.4 GHz channels (1–11)
  instead of just 1/6/11.
- Watcher's Watch and Sky Sweeper live-target lists now render in the app (they
  previously never populated); confidence/stalking badges added to target cards.
- The dashboard's ~1000-line inline script was extracted from `index.html` into
  `app/public/app.js` (no behavior change); unused React/Vite-plugin deps and
  dead patch scripts removed.

### Fixed
- **App/BLE state desync after backgrounding** — the app could show
  "disconnected" while the native BLE link was still live (and then fail to
  reconnect). It now reconciles against the real connection on resume and
  reattaches to an existing link instead of scanning.
- **`ble_write` spuriously re-locking the target** — a `ble_write`/`ble_spoof`
  command also fired the target-lock as a side effect; the lock is now gated on
  there being no `action`.
- **Bare-digit mode commands ("0"–"3") ignored** — a bare digit parses as valid
  JSON, so it bypassed the raw-text handler and did nothing; now handled.
- Firmware documentation corrected (there is no HTTP/REST server — everything is
  BLE NUS) and the app is documented as plain HTML/JS, not React.

---

Dates are ISO (YYYY-MM-DD). The app is pre-1.0 (`0.0.0`); this is the first
recorded changelog and covers work to date.
