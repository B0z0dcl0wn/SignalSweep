# Changelog

All notable changes to SignalSweep are recorded here.

## [Unreleased] — 2026-09-02 — Put back what we missed, not what was wrong

The previous pass was right about the two things that hurt — a passive location
trail on a seizable phone, and a signature list that cried wolf — and wrong
about how much it had to delete to fix them. This restores the map, the
category tabs, the per-target detail and the full Remote ID decoder, without
restoring the trail, the false positives, or the mode state machine.

The old build was resurrected into `SingalSweep_OLD/` as a reference for this
merge. Nothing was copied from it unexamined; the "Kept dead" section below is
the point of the exercise.

### Added — full ASTM F3411 Remote ID decode

- The drone check was presence-only ("a drone is broadcasting near you"). It now
  **decodes**: UAS serial, operator ID, self-ID text, the aircraft's own
  latitude/longitude/altitude/AGL/speed/heading, and the **operator's**
  position. Remote ID is a broadcast standard whose whole purpose is to be
  readable, so this is all handed to us in the clear.
- Three paths: BLE service data `0xFFFA`, Wi-Fi beacon vendor IE (`90:3A:E6`
  ASTM / `FA:0B:BC`), and Wi-Fi NAN action frames to `51:6F:9A:01:00:00`. The
  vendored upstream `opendroneid.c` + `odid_wifi.c` are back, unmodified.
- **Fixed a buffer over-read while porting it.** Sky Sweeper computed the
  beacon IE payload length as "everything to the end of the frame", which fed
  the decoder every subsequent information element plus the FCS as if it were
  drone payload. The length now comes from the element's own `elen`.
- `ODID_UAS_Data` is ~1 KB and both detection paths run on tight callback
  stacks, so the decode buffers are file-static, one per radio.
- Telemetry cost is contained: the drone block ships only on targets that
  actually decoded one, each field is emitted once (Sky Sweeper sent every
  value twice under two names), and any field still holding an ODID "unknown"
  sentinel — 0/0 for a position, -1000 m, 361° — is dropped rather than sent.

### Added — Hunt and Ring

- `{"hunt":"<mac>"}` points the buzzer's Geiger clicker at one MAC: the click
  rate rises as you close on it, so a planted tracker can be walked down by
  ear. `{"hunt":""}` clears it. The clicker itself already existed in
  `hardware_manager.cpp` with zero callers; this wires it up rather than
  rewriting it. **Detection never stops** — every other category keeps
  beeping normally while you hunt.
- `{"ring":"<mac>"}` makes a suspected tracker announce itself: one GATT write
  to Immediate Alert (`0x1802` / `0x2A06` / `0x02`). **The MAC is the only
  parameter** — service, characteristic and value are fixed in the firmware.
  The old build exposed arbitrary service/characteristic/hex writes next to an
  advertisement spoofer; that shape is what made it an offensive tool, and it
  is not coming back through this door.
- Ring runs on the 1 Hz task, never on the NimBLE write callback that requested
  it, and is bracketed by `pauseBle(true/false)` so a failed connect can't
  leave the detector deaf.

### Added — lens tabs, richer cards, live map

- Four tabs (All / Surveillance / Trackers / Drones) replace the old mode
  selector. Critically they are a **filter over what the detector already
  reported**, not modes: switching one sends nothing to the device, so the
  detector can never stop watching a category because the UI is looking
  elsewhere. That was the real content of the old five modes — one detector
  wearing different filters — minus the state machine.
- Cards now show the confidence tier badge, and drones render their decoded
  serial, operator, altitude, speed, heading and coordinates. Tracker cards get
  Hunt and Ring buttons. Every device-supplied string goes through `esc()`, and
  MACs ride in `data-mac` attributes read by a delegated listener — never
  interpolated into an `onclick`.
- The Leaflet map is back, live-only. Drones get a **solid marker at their
  broadcast coordinate**, because that number is real. Everything else gets a
  **dashed, unfilled ring of RSSI-estimated radius centred on you** — we know
  roughly how far, never where, and a pin would be a lie. Saved pins overlay
  only when the store is already unlocked; opening the map never prompts for
  the PIN.

### Fixed

- **`liveMatches` was never actually cleared on disconnect.** It was documented
  as cleared and behaved as if it were — rows aged out of the view after 8 s —
  but the object retained every MAC, name and RSSI for the life of the tab, and
  would now also have held decoded drone and operator coordinates. Nothing was
  ever written to disk, but a session-long list in a live tab is still a list.
  `onDeviceDisconnected()` now calls `clearLiveState()`. `handledMacs` is
  deliberately not cleared, or a flapping link re-prompts for recording consent
  on every reconnect.

### Removed — signature defaults v5

Two more rules of the same class as the `mfg_id 0x01` entry that labelled Govee
bulbs "Flock Safety". Both scored at or above `CONF_ALERT_MIN` (70), meaning
either could sound the alarm entirely on its own:

- **Device names `raven` and `penguin`** — ordinary product words, matched as
  case-insensitive substrings, at `W_NAME` 70. Enough to beep at someone's
  bluetooth speaker.
- **Service UUIDs `3100` / `3200` / `3300` / `3400` / `3500`** — four hex
  digits, substring-matched against every UUID a device advertises, at
  `W_UUID` 70. A UUID rule has to be specific enough to stand alone, because
  `CONF_ALERT_MIN` is exactly what lets it.

`SIG_SCHEMA_VERSION` bumped to 5 so already-deployed boards actually pick this
up — the file survives a flash, which is the whole reason the version exists.
Either rule can be pushed back from the app's signature editor if wanted;
removing them from the *defaults* removes the misfire, not the capability.

### Kept dead — deliberately not restored from the old build

- The 40-entry "GoFlockYourself" OUI list's four worst members: `a4:cf:12` and
  `3c:71:bf` (Espressif — this board's own vendor block), `cc:cc:cc` (not an
  assigned OUI), `82:6b:f2` (locally-administered bit set, i.e. a randomized
  phone MAC). The load-time rejection of locally-administered prefixes stays.
- `mfg_id 0x01` "Flock XUNTONG" — Bluetooth Company ID `0x0001` is Nokia's.
- `ble_spoof` and arbitrary GATT writes. GATT interrogation was also left out.
- The `sightStore`, the geospatial classifier, the OSM ALPR cross-check,
  passive `watchPosition`, and the breadcrumb polyline.
- `leaflet.offline` and its tile cache — cached tiles persist on disk and
  record which areas you downloaded. Dependency dropped from `package.json`.
- The firmware mode state machine: `modeChangeQueue`, `MODE_SELECTOR`,
  per-mode NVS, the BOOT-button-to-selector.
- `CONFIG_BT_NIMBLE_EXT_ADV`, still off, still warned about.
- The canvas radar view. The live map does the same job with real coordinates;
  the old radar placed most blips at a random per-MAC angle, which reads as a
  bearing but isn't.

### Note for the next port

`odid_wifi.c` (the old tree's `wifi.c`) looks like the unused upstream Wi-Fi
helper and is not: it implements both `odid_message_process_pack()` and
`odid_wifi_receive_message_pack_nan_action_frame()`. Omitting it fails at link,
not at compile.

## [Unreleased] — 2026-09-01 — Peel back to a simple beeper

A deliberate reversal of the geospatial direction below, on two grounds: opsec
(the passive location history was a liability if the phone was ever found) and
simplicity (five modes were one behaviour — "match a known signature, beep" —
wearing different filters).

### Removed — the passive trail

- **Deleted the geospatial `sightStore`, the Leaflet map, the OSM history
  export, and all passive `watchPosition` logging.** The app kept a record of
  everywhere the device had been; a found phone betrayed the owner's movements.
  It now keeps **no history** — a live scope of what's matching right now,
  cleared on disconnect.
- **Collapsed five firmware modes into one always-on detector.** Removed the
  mode selector, the FreeRTOS mode queue, per-mode NVS, and the
  `mode_shadow` / `mode_beacon_bandit` / `mode_sky_sweeper` files plus the
  vendored `opendroneid.c` / `wifi.c` ODID decoder (~2,100 lines). The app
  bundle dropped from 179 kB to 19 kB (Leaflet gone).

### Changed — hardware

- **NeoPixel moved to an external 8-LED strip on GPIO2** (`NEOPIXEL_PIN 2`,
  `NEOPIXEL_COUNT 8` in `hardware_manager.h`), up from the single onboard LED on
  GPIO21. Buzzer stays on GPIO3. Category alert colours now light the whole
  strip.

### Added — headless identification + consented evidence

- **The buzzer pattern is the identification.** One detector runs BLE + WiFi
  concurrently and matches Flock/ALPR/camera, Axon body cams, drone Remote ID
  (BLE `0xFFFA` / WiFi vendor IE), and Apple Find My / Tile / SmartTag trackers.
  Each category sounds a distinct pattern (`triggerCategoryAlert`): ALPR two
  long beeps, body cam long-short-short, drone rising trill, tracker fast
  ticking — so a dash-mounted device tells you *what* is near with no screen.
- **The firmware confidence gate now governs the beep and the reported list.**
  With the phone classifier gone, the `W_*` weights are the anti-false-alarm
  gate (this inverts the old "never gate in firmware" rule, which existed only
  to feed the classifier).
- **Opt-in, per-device, encrypted location pins.** Recording defaults OFF. When
  on and a known device is detected, the phone asks — per device — whether to
  drop a pin. A Yes captures one GPS fix (never a track) and stores it as
  AES-GCM ciphertext behind a PIN (Web Crypto, no dependency). Detecting/beeping
  never needs the PIN; it gates only viewing/export. OSM export survives, scoped
  to those consented camera pins (that's DeFlock, not a movement leak).

## [Superseded] — 2026-09-01

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

### Fixed — the app gave up on the device, and the buzzer cried wolf

Both found by instrumenting a real field session rather than by reading code.
A 2 h 17 m drive produced **8.1 seconds** of data: 37 devices, all `candidate`,
all at one cluster (the driveway). Two independent faults, and between them they
explain every previous "hundreds of miles, nothing found" trip.

- **A dropped BLE link was terminal.** `onDeviceDisconnected()` set a banner,
  toasted, and stopped — there was no reconnect anywhere in the app.
  `reconcileConnection()` only re-syncs the UI on resume; it never re-establishes
  a dead link. Forensics on the phone: `localStorage` last written 12:44:26, the
  GATT client still *registered* until 15:01:54, no data in between. The link
  died 25 s after connecting and nobody was looking at the banner, because the
  phone was mounted on a dashboard. There is now a capped-backoff reconnect loop
  (2 s doubling to 30 s, forever) driven off a persisted `deviceId` — a
  `requestDevice()` chooser is useless to a driver, but a remembered id
  reconnects silently. A deliberate disconnect cancels it, so the button still
  means what it says.
- **The buzzer alerted on the sum of vague hints.** Confidence accumulates, so a
  consumer device on a listed OUI (30) that also carries the Lite-On vendor IE
  (30) landed on exactly `CONF_LIST_MIN` (60) and sounded the alarm. Confirmed in
  the field: it fired repeatedly on a route with no ALPR anywhere near it — the
  Lite-On OUI `50:6F:9A` rides countless consumer Wi-Fi chips. Alerting now tests
  the **strongest single signal** (`bestWeight >= CONF_ALERT_MIN`, 70), so it
  takes one signal that identifies something on its own — an SSID (80), device
  name (70) or service UUID (70) — never a pile of generic ones. The summed score
  still drives the list and the tier, where being generous costs nothing.

### Added — the buzzer follows the geospatial verdict

- **`{"alert": 0-100}` over NUS**, handled by `processIncomingCommand()` and
  backed by `watchersNoteExternalAlert()`. Detection moved to the phone because
  only the phone has GPS, but the *alert* stayed in the firmware bolted to the
  signature list — so the device could only ever shout about brands it already
  knew, which is exactly the blindness the geospatial classifier exists to fix.
  The app now fires this the moment `classify()` promotes a device out of
  `candidate`: 90 (alarm) for a confirmed fixed installation, 70 (warning) for a
  possible tail. Edge-triggered per device and rate-limited to one every 5 s, so
  driving into a cluster of cameras does not turn the buzzer into a siren.

### Fixed — the sight store was deleting confirmed detections

Confirming a fixed installation takes repeat visits across days, so weeks of
history *is* the detector. Two storage rules were quietly throwing that history
away, which un-detects cameras the classifier had already paid for.

- **Quota eviction kept chatty noise and deleted cameras.** When `localStorage`
  filled, `sightStoreSave()` sorted by `count` and dropped the weakest half. But
  `count` measures how *talkative* a radio is, not how *interesting*: a
  slow-beaconing ALPR caught on two drive-bys sits at ~6 sightings while a
  neighbour's smart TV sits at 4000 — so the eviction reliably kept the TV and
  binned the camera. This is the same mistake the firmware's report cap is
  already forbidden from making with RSSI, one layer up. Eviction now orders by
  what a record *is* (`classify()`): unclassified candidates go first, stalest
  first, and confirmed findings go last. If a finding ever does have to go, the
  user is told rather than losing it silently.
- **The 30-day stale prune expired confirmed installations.** A camera confirmed
  in March that you didn't drive past in April was deleted in May and had to
  re-earn its two visits from scratch. Confirmed `fixed` records are the output
  of the whole system and there are only ever a handful — they are now exempt.
  Pruning of one-hit randomized MACs is unchanged; that is what keeps the store
  small enough for `localStorage` to remain the right call.

### Added

- **Back up / restore detection history** (Settings). Weeks of visit history
  lived in exactly one `localStorage` key on one phone, so Android "Clear data",
  a reinstall or a new handset erased every confirmed detection. Export writes
  one JSON file carrying the sighting store *and* the whitelist — the whitelist
  is equally unrecoverable, and restoring sightings without it re-floods both
  lists with the user's own gear. Import **merges** rather than replaces, taking
  the max (never the sum) of every counter, so a restore cannot clobber
  sightings made since the backup and re-importing the same file twice cannot
  inflate a device into a false `fixed`.
- **OSM cross-check for confirmed installations** ("Check vs. OSM", War
  Flocking). OpenStreetMap already carries crowd-mapped ALPRs
  (`man_made=surveillance` + `surveillance:type=ALPR`) — the dataset DeFlock
  renders — and the geospatial classifier had no independent check against it.
  The map now shows three outcomes, and the third is the point of the whole
  project: **corroborated** (you confirmed a radio where OSM says a camera
  stands), **mapped only** (OSM knows it, you never heard it), and **unmapped**
  — a fixed installation you confirmed that nobody has mapped. Corroboration is
  a *label* and never feeds `classify()`; letting OSM promote or demote a
  detection would re-introduce exactly the list-shaped blindness the geospatial
  test exists to avoid, same rule that already governs signature matches.

  The query runs **only on the button press**, never on map pan or app start:
  asking Overpass about a bounding box tells a third party which patch of the
  world you are looking at, and for this tool's users that is a real disclosure.
  Results are cached in `localStorage` and merged by node id, so panning builds
  an area up rather than replacing it and a field trip can run off a prefetch
  made at home — the same offline story as the saved map tiles. Falls through to
  a second Overpass mirror on 5xx (the public endpoint rate-limits at 2 slots),
  then to the cache.

  Confirmed detections were also never actually drawn on the map, despite a
  comment claiming they were — only the GPS trail was. They are now, which is
  what makes the comparison visible at all.
- **`app/selftest.js`** — the sight-store self-check's comment claimed
  `node app.js` ran it headless; it never did (`window is not defined`). A ~25
  line DOM stub makes `node app/selftest.js` real, and the check now also covers
  eviction order, the prune exemption, and backup round-tripping. Verified by
  reverting both fixes and confirming the new assertions fail.

Both of these came out of a three-way comparison against two sibling projects.
The other project's SQLite/Drift session database was deliberately *not* copied:
it earns its keep there on many mesh nodes and many concurrent engines, and buys
zero detections for a few hundred records on one phone. Its real advantage was
that its store was a file you could copy, which is what the backup takes. Its
DeFlock/OSM overlay was worth taking outright.

### Changed — telemetry cost

Measured, not guessed: a 60 s soak showed the "1 Hz" push actually running at
0.77 Hz (46 pushes in 60 s) at ~33 devices, with 5.5 KB per push. Removing the
confidence gate took Watcher's Watch from 0-3 reported devices to as many as 40,
which made the telemetry path the dominant cost in the loop. After these three
changes the same soak gives **59 pushes in 60 s at ~2.8 KB** — cadence restored,
payload roughly halved.

- **Don't notify a characteristic nobody is subscribed to.** `sendBleSerial()`
  chunked and slept its way through the whole payload even with no BLE client
  connected. With no peer there is also no negotiated MTU, so a ~3 KB push
  fragmented into ~146 twenty-byte notifications with a yield between each —
  ~300 ms of every telemetry period spent talking to nobody. This was the actual
  cause of the slipped cadence; the other two below are real savings but did not
  move it on their own.
- **Chunk to the negotiated MTU instead of a fixed 180 bytes.** `onMTUChange`
  records what the peer agreed and `NimBLEDevice::setMTU(517)` raises the
  ceiling; at a typical 247-byte MTU that is 244 bytes per notification instead
  of 180. Falls back to 20 (the 23-byte BLE default minus 3) when nothing has
  been negotiated, which is correct rather than merely lucky.
- **Inter-chunk delay 10 ms -> 2 ms.** At ~32 chunks the old value was 320 ms of
  pure sleeping per cycle.
- **Dropped `first_seen_ms` / `last_seen_ms` / `duration_ms` from the wire** in
  all four modes. The app reads none of them — it keeps its own wall-clock
  timing in `sightStore` — and they were roughly a quarter of the payload.
  `durMs` still feeds the Beacon Bandit stalking score internally; it just isn't
  transmitted.
- **The USB serial mirror is gated on a host actually being attached**
  (`if (Serial)`), instead of pushing the same kilobytes out CDC unconditionally.

### Added

- **The buzzer now fires from the Wi-Fi path, not just BLE.** With no phone
  connected the buzzer is the whole user interface, and the strongest Flock
  signal in the system — an SSID match, weight 80 — exists only on the Wi-Fi
  side and made no sound whatsoever, because the only `triggerAlarm()` calls
  lived in the BLE callback. Both paths now record the hit and the 1 Hz task
  sounds it: >= 75 alarms, 60-74 warns, below 60 stays silent. Routing it
  through the task keeps the Wi-Fi promiscuous callback non-blocking (the
  trigger functions take a 10 ms mutex) and rate-limits a dense area to one
  alert per second instead of a continuous tone.
  Note this is inherently a *signature* alarm: the geospatial "is it bolted
  down" test needs GPS, which lives in the phone until Tier 3, so headless can
  only ever shout about brands it already knows.
- **`CMD:SIGS:RESET`** — restore the built-in signature rules. Once a rule set
  had been pushed there was no way back short of a full factory reset, which
  also wipes the mode and target lock.
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

- **LittleFS was never mounted, so the entire signature database has never
  loaded — on any build, ever.** Nothing called `LittleFS.begin()`. Every
  `LittleFS.exists()` therefore returned false and every `open()` failed, so
  `ensureSignaturesFileExists()` could not write the defaults and
  `loadWatchersSignatures()` bailed out leaving `loadedSignatures` empty. Every
  OUI, device-name, service-UUID and manufacturer-ID rule was dead code; the
  only Watcher's Watch detections that could ever fire were the two hardcoded
  checks in the Wi-Fi callback (the Lite-On vendor IE and the SSID keyword
  test), neither of which consults the rule list. Mounting it immediately
  brought the rules to life on the bench — and immediately exposed the next
  item.
- **Removed the `mfg_id: "0x01"` "Flock XUNTONG" default rule.** Bluetooth
  Company ID `0x0001` is Nokia's, not Flock's. Within seconds of the rules
  actually loading it was labelling Govee smart bulbs `"Flock Safety"`, tier
  `"Likely"`, at confidence 45. Same class of junk as the Espressif OUIs, and
  invisible until the filesystem worked. (Schema v3.)
- **Pushing a rule set with `{"signatures":[...]}` was a silent no-op.**
  `updateWatchersSignaturesJson()` wrote the file and then called
  `loadWatchersSignatures()`, which calls `ensureSignaturesFileExists()`, which
  saw no `version` field, judged the file stale against the new
  `SIG_SCHEMA_VERSION`, and deleted it. Pushed rules now carry the current
  version stamp.


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
