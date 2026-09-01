# Changelog

All notable changes to SignalSweep are recorded here.

## [Unreleased] — 2026-08-31

### Changed — detection methodology

- **Watcher's Watch now finds cameras it has never heard of.** Detection was
  100% vendor fingerprinting, gated in firmware at `CONF_LIST_MIN 60`, so an
  ALPR whose OUI wasn't on the list never even reached the phone. The firmware
  is now a harvester — it reports everything it hears, with the signature
  confidence riding along as an annotation instead of a filter — and the phone
  classifies on **geospatial persistence**: a radio pinned to one place across
  repeat visits is bolted to something, whoever made it. Signature matches now
  only *label* what the geospatial test already found.
- **One shared sighting store.** Shadow's "seen in many places = a tail" and
  Watcher's Watch's "seen in one place across visits = infrastructure" are two
  queries against the same `sightStore`, which now **persists to localStorage**
  and survives restarts and mode switches (Shadow used to wipe its store on
  every mode entry, so confirming anything that takes days was impossible).
  Pruned aggressively — records still at one sighting after 24 h, anything
  unseen for 30 d — which is affordable because randomized MACs never earn a
  second visit and evaporate on their own.
- **A "visit" means you left and came back**, not that you lingered. Tracked by
  the phone's own travel (an epoch ticks each time *you* move >200 m), so an
  hour in a café counts once rather than confirming every radio in the building.
- **GPS accuracy is now respected.** Fixes vaguer than 50 m no longer place a
  device at all, and cluster centroids re-centre as a running mean — previously
  a cluster was a seed point that never moved, so one bad early fix anchored a
  camera to the wrong corner permanently, and that was the coordinate the
  export would publish.
- **Report caps are round-robin by staleness, not by RSSI.** Shadow sorted its
  40-device report by signal strength, so a crowd of loud stationary devices
  could permanently crowd out the persistent distant one the whole mode exists
  to catch. Both modes now report least-recently-seen first; Watcher's Watch
  pins signature hits so the alarm stays live on them.
- **Passive scanning where it costs nothing.** Sky Sweeper and Shadow no longer
  transmit `SCAN_REQ` at everything in range — Remote ID and sighting
  harvesting need only the advertisement. Watcher's Watch and Beacon Bandit stay
  active, where scan-response device names drive the rules.
- **Sky Sweeper keys on the UAS ID, not the MAC.** Remote ID transmitters rotate
  their MAC, so one aircraft used to become a new target — and a fresh alarm —
  on every rotation.
- **BT5 extended advertising / Coded PHY was attempted and backed out.**
  Remote ID is permitted over it and those transmitters are invisible without
  it, and enabling `CONFIG_BT_NIMBLE_EXT_ADV` gets the scan for free (NimBLE
  switches to `ble_gap_ext_disc()` with params for both PHYs, no Sky Sweeper
  change needed). But it also swaps `NimBLEDevice::getAdvertising()` to
  `NimBLEExtAdvertising`, and the reworked advertising path did not come up
  discoverable — the app could not connect at all. Losing the control link to
  the whole device to gain a minority of drone transmitters is a bad trade, so
  the flag is off. `startNusAdvertising()` is still written against both APIs,
  so re-enabling is a one-line change in `platformio.ini` once someone can test
  it against a real BT5 transmitter.
- **Wi-Fi channel dwell** cut from 250 ms to 150 ms (a 2.75 s → 1.65 s cycle),
  with an extra dwell granted to any channel that just yielded an ODID frame.
  `esp_wifi_set_promiscuous_filter(MGMT)` is now set in all three Wi-Fi modes —
  it never was, so every frame in the air reached the ISR only to be dropped in
  software.
- **Signature defaults are versioned and self-heal on flash**
  (`SIG_SCHEMA_VERSION`). `/data/signatures.json` lives on LittleFS and survives
  a firmware upload, and `ensureSignaturesFileExists()` only wrote defaults when
  the file was *missing* — so every already-booted device would have silently
  kept the old rule set below for ever. The file now carries a `version` and is
  regenerated when the defaults move ahead of it.
- **The signature list no longer contains entries that cannot mean "Flock".**
  Removed `a4:cf:12` and `3c:71:bf` (Espressif — this board's own vendor block,
  so every ESP32 in range matched), `cc:cc:cc` (not an assigned OUI), and
  `82:6b:f2` (locally-administered bit set, i.e. a randomized-MAC prefix that
  matches phones). Rules with the locally-administered bit are now rejected at
  load, including ones pushed from the app.
- Wi-Fi hits are labelled by **the rule that actually matched**. Every Wi-Fi
  detection used to be stamped `"Flock Safety"` regardless — so a Cradlepoint
  router or a stray ESP32 was reported as a Flock camera. The Lite-On vendor IE
  deliberately asserts no vendor at all.

### Added

- **The pilot's location on the map (Sky Sweeper).** Remote ID broadcasts where
  the *operator* is standing, and the firmware was already decoding and
  transmitting `operator_latitude`/`operator_longitude` — the app read the
  operator's ID string and threw the coordinates away. Drone and pilot now each
  get a marker, joined by a line.
- `window.__sightStoreSelfTest()` — runnable check for the store, visit logic,
  classifier, pruning and escaping. Also runs headless.
- `window.__sightDump([kind])` — console table of what the store currently
  believes: per device its classification, places, visits, hits, signature match
  and cluster centroid, plus the current visit epoch and GPS fix. The main
  field-debugging tool.
- The map is now shown in Sky Sweeper as well as War Flocking (it carries the
  drone/pilot markers); the `.osm` export button is hidden outside War Flocking,
  where it has no meaning.
- The "mark as mine" whitelist now suppresses a device in **both** branches. Your
  home router sits at one place you keep returning to, so it would otherwise
  confirm as fixed infrastructure, exactly as your phone would score as a tail.

### Fixed

- **Removed `restoreBleSerialAdvertising()`** — it had no callers anywhere in
  the tree, and it carried a latent bug worth recording because it bit during
  development of this very change set. It called `setAdvertisementData()` with
  an empty `NimBLEAdvertisementData` to "clear any custom payload", but that
  call pushes its payload to the controller *and* sets NimBLE's
  `m_customAdvData`, after which `start()` skips building the advertisement
  from `addServiceUUID()`/name (`NimBLEAdvertising.cpp`:
  `if (!m_customAdvData && !m_advDataSet)`). Anything calling it would have
  advertised an empty payload — no service UUID, no name — leaving the device
  undiscoverable to an app that filters on exactly those. The clear only ever
  made sense as a way to undo the `ble_spoof` custom payload, and `ble_spoof`
  was removed in 7d55f51. Advertising is now started from one place,
  `startNusAdvertising()`, which is documented never to do this.
- **`exportOSM` has never worked and now does.** It read a `trackedTargets`
  variable that doesn't exist in the app, so every click threw
  `ReferenceError`. Even had it run, it stamped every node with one coordinate
  (the phone's last position), read field names no telemetry emits, labelled
  everything a Flock ALPR, and did no XML escaping. It now emits one node per
  **confirmed fixed** device at **its own cluster centroid**, tags
  `man_made=surveillance` always, and adds a vendor claim only where a
  signature actually matched at Confirmed level — publishing a wrong
  manufacturer against a real location to a shared map is worse than
  publishing nothing.
- **Hostile device names could execute script.** Everything rendered via
  `innerHTML` string concatenation with unescaped device-supplied `name` /
  `value_ascii`, and MACs were interpolated into `onclick` handler strings. A
  BLE device chooses its own advertised name, and this app exists to be pointed
  at hostile hardware. All interpolation now goes through `esc()`; row actions
  use `data-mac` with delegated listeners.
- **Watcher's Watch leaked promiscuous mode.** `stopWatchersWatch()` never
  called `esp_wifi_set_promiscuous(false)` or cleared the rx callback.
- **Watcher's Watch never pruned its target list** — the only mode that didn't,
  so `trackedTargets` grew for the entire session. Now expires at 120 s.
- **Sky Sweeper's Wi-Fi beacon parser over-read.** `dataLen` was
  `length - dataStart` (everything to end-of-frame) instead of the vendor IE's
  own length byte, so the ODID decoder was fed the bytes of every subsequent IE
  plus the FCS as if they were drone data.
- Geolocation now falls back to `navigator.geolocation`. `window.Geolocation`
  only exists in the Capacitor build, so every geo feature — map trail,
  classifier, true-bearing radar — was silently inert during `npm run dev`.
- The Ring/Find button never appeared: it compared bare 16-bit UUIDs
  (`1802`/`2a06`) against the 128-bit strings NimBLE actually reports.
- `warFlockingPath` grew without bound — a stationary phone with jittery GPS
  appended every fix. Now gated on 10 m of movement.
- Removed dead code: `warFlockingMarkers`, `handleDeviceData`, `setupGeiger`
  (which called an undefined `updateGeigerUI`), the write-only `lastDeviceId`
  key, and four `{"get":"status"}` sends that matched no firmware branch.

### Added
- **Factory reset via the BOOT button** — hold BOOT for 5 s to erase all
  persisted state (NVS namespaces + LittleFS `/data/signatures.json`) and
  reboot as if freshly flashed. Red LED flash + a warning tone each second
  while held; release early to abort. A tap still resets to the mode selector,
  now firing on release so a tap and a hold can be told apart.
- **"Clear Target" button (Beacon Bandit)** — deselects the locked target from
  anywhere, appearing whenever the firmware reports a `locked_mac`. Previously
  the only way out was tapping the locked card, which is impossible once the
  locked device stops advertising and drops off the list (the lock persists in
  NVS).
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
- **One radar, not two** — removed the generic List/Radar view toggle and its
  canvas radar, which placed blips at random angles and duplicated the real
  Sky Sweeper radar (sweep animation + true GPS bearing).
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
