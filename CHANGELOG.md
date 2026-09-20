# Changelog

All notable changes to SignalSweep are recorded here.

## [Unreleased]

### Added — Answer the pin prompt for a whole category

- The prompt was Yes or No, one device at a time. The moment you know you do
  not care about a whole category *is* that prompt, and making it a dead end
  sent you to Settings to say what you had already decided. A third answer —
  **"No — and stop asking about trackers"** — names the category and silences
  it there.
- `pinMute` composes with `pinLens` rather than replacing it: the band tab
  picks *one* category to ask about, this subtracts categories from Everything.
  Muting drops every queued device of that kind too, or you tap through the
  backlog you just refused. The button's noun comes from a fixed per-key table,
  never `cat.label` — `other` labels itself with whatever vendor string tripped
  it ("Hacking gear"), and a button reading "stop asking about Hacking gear"
  would quietly mute every unrecognised category with it.
- The test sits *before* `handledMacs`, so un-muting brings devices back rather
  than skipping them for the rest of the session, and **Settings › Recording
  lists what is muted with a tap to undo** — a one-tap field decision has to be
  visible somewhere, or it is a prompt that mysteriously stopped working weeks
  later. The mute silences the prompt only: the category is still detected,
  still listed, still beeped.

### Fixed — Settings › Signatures showed nothing, and its one button threw

- The page was a sentence and an "Edit signature rules" button opening a raw
  JSON textarea. The button still called `getElementById('settings-modal')`,
  which stopped existing when Settings became a tab, so tapping it threw.
- It now lists the rules read off the board — name, category, and which field
  actually matches — fetched when the page opens, which is what "on demand"
  means for a reply too large to send on connect.
- **It also lists the protocol detectors first.** Drone Remote ID, Apple Find
  My, Tile, Pwnagotchi and the Flock wildcard probe are compiled in and match
  no rule at all, so a page showing only `signatures.json` implied the board
  cannot see a drone or an AirTag. That list is prose describing firmware
  behaviour: if the detectors change, it has to change with them.

### Changed — Three tabs, one Record button: the app's navigation rebuilt

- **Features had outgrown the navigation.** The main screen stacked six
  horizontal bands of chrome before a single result row (status strip, toolbar,
  scope head, band tabs, radio tabs, Wi-Fi role tabs), the header carried four
  icons, and ten overlays sat on top. Two of those overlays — the pin sheet and
  Site Survey — both started *recording sessions*, both held encrypted
  geolocated data behind the same PIN, and both exported, so which one you
  wanted was no longer obvious.
- **This was an information-architecture problem, not a framework one, and a
  rewrite was explicitly rejected.** `app.js` is behaviour — three transports
  and one line reassembler, the AES-GCM store, the capture analyzer, Leaflet,
  the hunt fast path, the device-authority paint rules — almost none of which a
  framework would delete; and `selftest.js` cross-checks every id-anchored
  selector in `app.js` against `index.html`, which a rewrite throws away. It
  earned its keep during this work: it caught two stale ids on the first run.
- **Three panels under one shared header, switched by a fixed bottom bar.**
  **Sweep** is live and moving; **Survey** is standing still and saving;
  **Settings** is what you set before you go. Every screen is one thumb-tap from
  every other, which is also the "back out" that a scrolling overlay with a
  small × never gave you. `showTab()` invalidates Leaflet's size when returning
  to a map that was `display:none` — it measures a hidden container as 0×0.
- **Recording is now one act.** There were two record mechanisms with two
  switches in one sheet, so "am I recording?" had two answers and you could
  easily be half on. One **Record** button on Sweep brackets an outing: Start
  turns the board's alert log on and arms the pin prompt; Stop reads the log
  back, writes the `.txt`, shows "what you passed" and disarms the prompt —
  unless it was already on beforehand, which the session remembers so Stop does
  not switch off something the operator set themselves. Stopping still never
  turns the board's own log off: the car case wants it logging after the phone
  is away. While running, the bar reads elapsed, alerts logged, pins dropped and
  which category is being pinned, ticking off the 1 Hz push rather than a timer
  of its own.
- **The separate "Pin which" picker is deleted.** It was a second control for a
  state the band tab already set (its own note said so), and two controls for
  one state only ever disagree. `pinLens` survives as a variable driven by the
  band tab; the Record bar states it.
- **Settings is an index of seven short screens, not one long scroll.** Alerts,
  Recording, Radios, Detection, Emissions, Device identity and Signatures each
  open their own page with a back link and the top bar naming it; Opsec is prose
  with no controls, so it stays a footnote on the index. This costs one extra
  tap to reach a control, accepted deliberately — these are set before you go
  out, and hunting down an eight-section scroll for one row was the worse trade.
  The live Alerts summary sits on its index row, so what is muted still reads at
  a glance without opening anything.
- **Alerts (sound, lights, theme, the five categories) moved into Settings.**
  These are set once before a hunt so you are not fiddling in the field, which
  makes them settings. The previous rule — that silencing a category must not be
  three taps deep — assumed Settings was a gear-icon modal; with a bottom bar it
  is one tap. The markup moved verbatim, so the ids and the device-only painting
  are untouched. **Accepted cost, decided deliberately:** there is no longer a
  sub-3-tap way to silence a beeping board, and BOOT is factory-reset, not mute.
- **Saved pins moved into Survey, beside the logged finds.** Same encrypted
  store, same PIN, same kind of record — the only difference is that one came
  from driving past and the other from standing at the pole with a camera. One
  unlock now serves both lists and one wipe covers the one store (it always took
  the finds and their photos with it — now it says so). Opening Survey still
  never prompts for the PIN. **Deliberately not merged: the exports.** A find is
  a photographed confirmation, a pin is a drive-by guess, and one export button
  would put guesses in `cameras.osm`. We never tag a guess onto OpenStreetMap.
- **The radio tabs and Wi-Fi role tabs became one row**, three chips at rest
  (All / BLE / Wi-Fi) and five once Wi-Fi is the chosen radio — AP and Client
  mean nothing under All or BLE, and five chips at rest was simply too many to
  read. They appear *in* the same row, never a second one: the old sub-row
  appeared and vanished with the Wi-Fi tab and moved every result below it by a
  row mid-scan. The strip's height is pinned (`#radios .radio-tab`
  `min-height`) because the five-up chips take a smaller face to fit 412 px and
  a smaller face is a shorter line box — 1.3 px of drift before it was pinned,
  0 px after. The row is `.radios.five`, an explicit modifier: `.radios` is a
  three-column grid shared with the segmented pickers, and redefining it would
  have stretched those — the same class reuse that once stretched the channel
  chips while the node self-test passed.
- **The three-cell status strip folded into the header's connection line**, and
  the GPS readout appears only when there is something to say (it read
  "Location: Off" approximately always and owned a third of that card). The
  transport shortens to BLE/USB/Serial, and the **name** is what gives when the
  line is tight, never the numbers: a default board name is 19 characters
  ("OUI-SPY-SIGNALSWEEP") and letting both shrink cut the alert count mid-word
  on the phone, which is the one thing there you cannot guess the rest of.
- **`scan_all` reads its state instead of a toggle name** — "Matches only" /
  "All devices", in the scope head beside Map. It was "Filter: On/Off", which
  meant the opposite of what it said (`foxhuntMode === true` means the filter is
  *off*) and collided with the radio chips for the word "filter". With Alerts
  moved out, the toolbar row is gone entirely.
- **The two connect buttons are adjacent.** The "tap BOOT to make it visible"
  hint sat between them, putting troubleshooting in the way of the button you
  came to press; it is read once and remembered, so it moved down to the
  support block beside the USB note.
- **The Help modal is deleted.** Its content was duplicated everywhere it
  mattered — the beep legend in the Alerts rows, opsec in Settings, pins in
  Record — and its one unique line ("it still beeps without the phone") already
  sits in the disconnected empty state.

### Fixed — A recording bookmarked the board's clock as of *connect*, not as of Start

- `log_boot`/`log_secs` arrive only in the `CMD:CFG` reply, and the app asks for
  that exactly once per connection — the 1 Hz push carries only `log` (a bool).
  So the session bookmark was frozen at connect time: starting a recording an
  hour into a drive bookmarked an hour ago, and Stop read back every alert since
  then, including everything from before the tap. Survivable while Start was a
  button buried in a sheet; not once Record is the primary control.
- `log_secs` is seconds since boot, which is exactly what `bootAt` (from
  `cfg.uptime`) already tracks, so the bookmark is recomputed at Start with no
  extra round trip and **no new field on the push** — telemetry is the tightest
  budget on the device and this costs it nothing. Confirmed against hardware,
  where a fresh board reported `log_secs: 11` against `uptime: 12`.

### Fixed — "Connecting…" was written to an element nobody could see

- Six call sites wrote `CONNECTING BLE...` / `RECONNECTING (Ns)...` into
  `#connStatusText`, inside a status badge that was markup-level `hidden`. A
  slow BLE connect therefore looked like a frozen app. Those states now paint
  the header's own connection line, and the badge is deleted.

### Fixed — The BLE command handler was overflowing the NimBLE host task stack

- **A phone connecting to the board could boot-loop it.** The BLE write callback
  (`onWrite` → `processIncomingCommand`) runs on the NimBLE host task, whose stack
  defaults to 4096 bytes, and the `CMD:CFG` reply builds JSON while doing several
  NVS flash reads — already close to that limit. Adding the alert-log command
  parsing enlarged the handler's stack frame (the compiler reserves space for
  every branch's locals, even the `CMD:CFG` path that uses none of them), which
  tipped it past the canary: the phone connects, the board panics
  (`Stack canary watchpoint triggered (nimble_host)`), reboots, the phone
  reconnects, and it loops. It was invisible until now because the board had only
  ever been driven over USB, where commands are processed on `loop()`, not the
  host-task callback.
- **The NimBLE host task stack is now 8192** (`CONFIG_BT_NIMBLE_HOST_TASK_STACK_SIZE`,
  both S3 and C5), and `sendAlertLog()`'s ~1 KB base64 buffer moved from the stack
  to the heap so a log readback — which also runs on that callback — cannot
  overflow it either. Verified on hardware: a phone connects and holds, a full
  Start→alerts→Stop session reads back 6 alerts (3 drone, 3 camera) and writes the
  `.txt` with no panic.

### Added — An alert log on the board's own flash, read back by the phone

- **The device now keeps a record of what its buzzer sounded — with no phone
  required.** The detector is headless and often unattended: wired into a car it
  runs whether or not a phone is present, and driving, you cannot look at the
  screen. Off by default, `{"log":bool}` / `CMD:LOG:ON|OFF` (persisted in
  `sweep-st`, echoed in `CMD:CFG` and the push, adopted by the app) makes it
  write every alert to LittleFS: a 16-byte record of time-since-boot, MAC,
  category and RSSI, plus a per-log rule-name table so the log carries its own
  names and editing the signature list later cannot mislabel an old log.
  **No position is recorded, by design** — the app's whole opsec property is that
  it keeps no passive trail, and times-and-MACs is the most that can be logged
  without rebuilding the `sightStore` that was removed.
- **It had to be the board, not the phone.** Android cannot auto-launch an app on
  a BLE GATT connection (that belongs to paired Bluetooth Classic devices like
  headphones), and keeping a backgrounded WebView alive with the screen off needs
  a foreground service with a permanent notification — which collides with this
  app posting none. A log on the board works with the phone dead, absent, or in a
  pocket, and it collapses the walk/bike case and the car case into one feature.
- **The ring has no stored write pointer, and that is the load-bearing trick.**
  A pointer would mean an NVS write per alert (flash wear on a device meant to run
  for months) and could still disagree with the data after a power cut, which
  this device suffers every time the engine stops. Instead a boot counter (one
  NVS write per boot) makes each record's `(boot, seconds)` key monotonic across
  power cycles, so the ring is a rotated sorted array and its head is found by
  binary search (~17 reads) at startup. When full it **wraps**, overwriting the
  oldest — losing old history beats missing the next device. Proven on hardware:
  a bench harness shrinks the ring and overruns it (27/27 checks — wrap
  boundaries, no gaps or duplicates, head recovered after reboot), and a real
  mid-write USB power-pull left the log intact with its ordering monotonic and at
  most the one in-flight record lost.
- **The write never happens on a radio callback.** `noteAlertForTarget()` runs on
  both the BLE scan and Wi-Fi promiscuous callbacks and only flags the target; the
  1 Hz task collects flagged targets under the mutex and writes them to flash
  *after releasing it*, because a LittleFS write is tens of milliseconds and the
  BLE callback takes that same mutex. The flag is set only when the alert actually
  sounded, so a muted `beep_mask` category and an active hunt write nothing — the
  log is a faithful record of what you heard. Telemetry stayed healthy through it:
  123 pushes in a 120 s soak with logging on.
- **The app reads it back over the existing pipe.** A ranged, chunked,
  resumable `CMD:LOG:READ:<boot>:<secs>:<skip>` streams base64 records the same
  way capture streams `CAP:` lines — a walk or a drive is tens to a few hundred
  records, seconds over BLE. Start/Stop in the Record sheet is an **app-side
  bookmark**, not a board mode: the board logs continuously either way, and Stop
  reads back the bookmarked stretch, writes a plaintext `.txt` to Documents
  (wall-clock times derived from the board's uptime, vendor names from the
  offline OUI tables), and shows a "what you passed" summary. Every field decodes
  faithfully — the 16-byte layout is pinned between firmware and `app.js` by
  `selftest.js`, because a byte-off record would be the Remote ID offset bug all
  over again: every field wrong, nothing visibly broken.

### Added — Pwnagotchi (pwngrid) detection, behind an off-by-default toggle

- **The detector now flags a nearby Pwnagotchi.** A pwnagotchi advertises itself
  to other units over pwngrid: Wi-Fi beacons from the fixed source
  `de:ad:be:ef:de:ad` carrying its advertisement (name, pwned count, grid
  version) in vendor information elements. A match lists under **All** as a
  "Hacking gear" row titled `Pwnagotchi '<name>' - <N> pwned` and sounds the
  generic alert. It is **not** a camera or tracker, so it never appears on those
  tabs.
- **It rides a new persisted toggle, off by default.** `{"attack":bool}` /
  `CMD:ATTACK:ON|OFF`, stored in `sweep-st`, echoed in `CMD:CFG` and the 1 Hz
  push, adopted by the app (Settings → Detection). Off by default because attack
  detection is attack-adjacent and its future rate-based detectors (deauth,
  karma) trip in busy places; the toggle gates them all.
- **The wire format was read from pwngrid v1.10.3 source, and it is
  gzip-compressed.** The advertisement rides IE 222 (`IDWhisperPayload`, chunked
  at 0xFF); IE 223 (`IDWhisperCompression`) = 1 means the payload is gzip, which
  a real advertisement is, because it shrinks. A first cut that parsed IE 222 as
  raw JSON would have detected only an uncompressed test beacon and **missed
  every real pwnagotchi** — the kind of gap that looks like a working feature on
  the bench and silence in the field. The S3 now inflates the payload with the
  ROM's `tinfl_decompress` (exported in `esp32s3.rom.ld` via `rom/miniz.h`) — no
  new dependency, no vendored code — with a file-static decompressor and output
  buffer kept off the promiscuous-callback stack. Verified end to end: a
  byte-faithful gzip beacon was detected in 41 of 41 telemetry pushes at
  confidence 100.
- **The C5 cannot gunzip yet, deliberately.** Its ROM (IDF 5.x) dropped miniz, so
  `rom/miniz.h` does not exist there; the gzip path is gated behind
  `PWN_HAS_GUNZIP` (`#if !defined(CONFIG_IDF_TARGET_ESP32C5)`). The C5 detects an
  uncompressed pwngrid advertisement but skips a compressed one until a portable
  inflate is vendored. Both build environments compile.

### Changed — The camera tab is strictly ALPR and mass surveillance

- **The Surveillance/camera tab now shows only ALPRs and mass-surveillance
  cameras (Flock, SoundThinking) plus body cams (Axon) — nothing else.** Before
  this, any device whose category the app did not recognise fell into the
  catch-all `other` bucket, which `inLens()` counted under the camera tab, and
  `LENS_MASK.alpr` even included the generic beep bit. So a police-car router
  (Cradlepoint / Peplink / Sierra), or any future unlabelled match, was listed
  under Cameras and could beep while you were on that tab — the `bandOf()` class
  of mistake, a weak or wrong hint being worse than none. The tab is now exactly
  the `alpr` + `bodycam` categories; everything else (fleet routers, and any
  category with no keyword) lives under **All** only, in the list and in the
  tab's beep preset.
- **SoundThinking / ShotSpotter is now named explicitly** in both
  `categoryOf()` (app) and `alertCategoryFromName()` (firmware) so it routes to
  the ALPR category and stays on the camera tab, rather than falling through the
  catch-all it no longer has. A new `selftest.js` check fails if the two keyword
  lists drift, since a mismatch would file a vendor under Cameras in the app
  while the firmware beeps it as generic — a silent camera on the camera tab.
- Body cams (Axon) stay on the tab (counted as mass surveillance here); fleet
  routers move to All-only, which falls out of the same change.

### Fixed — Connect tells you when Bluetooth is off

- **Tapping Connect on Android with Bluetooth off used to open an empty picker**
  with no hint why: the scan simply found nothing. The app now checks the radio
  first and raises Android's own "turn on Bluetooth" dialog; Allow goes
  straight on to the device picker. Deny opens the system Bluetooth settings
  page and stops, rather than scanning a radio that is off. Verified on the
  OnePlus with Bluetooth disabled over `adb`: both branches behave as described.
- **Location switched off no longer reads as a slow GPS lock.** `getFix()` used
  to show "Locating…" then "No fix", which sends you outside to wait for a fix
  that can never arrive. It now checks the system switch first, shows
  "Location is off" in the status strip, and opens the location settings page.
- **A refused Nearby devices permission points you at the fix.** After one
  refusal Android stops asking, so every Connect ended in a raw
  "Permission denied." toast. The app now says which permission it needs and
  opens its own App info page, where it can be allowed again.
- **Closing the device picker is not an error.** It used to raise a red
  "Native BLE Connect Failed: requestDevice cancelled." toast; it now just
  closes. All three verified on the OnePlus (location off via `adb`, the
  permission revoked and marked don't-ask-again with `pm set-permission-flags`).
- **The Connect sheet says why a board can be missing from the picker.** A
  board in receive-only does not advertise, and one still connected to another
  phone has stopped advertising, so both are simply absent from the list, and
  the Android picker cannot say whether it found anything at all. A standing
  line under the Bluetooth button points at the BOOT tap (2 minutes visible)
  and the other-phone case, so it is there when you need it and never nags.
- **Connect and send errors say what to do, not what the plugin said.**
  "Native BLE Connect Failed: Connection failed with GATT_ERROR." and
  "USB Connect Failed: IO_ERROR" were developer text. `friendlyError()` maps
  the known plugin and browser errors (BLE timeouts and GATT failures, a lost
  link, USB permission and I/O errors, a busy serial port) to a next step, and
  keeps the raw text for anything it does not recognise so an odd failure can
  still be reported. Verified on the OnePlus by parking the S3 in its ROM
  bootloader (`esptool --after no-reset`) between the picker listing it and
  the tap: "Can't reach the board. Check it has power and is close by, then
  tap Connect." The in-app self-test pins the mapping (`friendlyErrors`).

### Fixed — The tracker category means something again

- **A Find My hit now requires the 25-byte payload.** Apple sends message type
  `0x12` in two shapes: a 2-byte status ping that *every* iPhone, iPad and Mac
  emits constantly, and the 25-byte offline-finding payload carrying the
  rotating public key — i.e. an item findable while **separated from its
  owner**. Matching on the type byte alone called both a tracker. Measured
  across 18 bench and field captures: **1095 distinct MACs sent the short form,
  64 sent the long one**, so a rural convenience store reported 22 AirTags that
  were the customers' phones. A category that fires on every phone in the room
  is worse than no category at all. Accepted tradeoff: an AirTag sitting beside
  its owner advertises the short form and is not flagged — but that is the case
  where the owner is standing next to you anyway. A planted tracker is
  separated by definition.

### Added — Trackers beyond Apple

- **Tile, Samsung SmartTag and Google Find My Device are detected too.** Apple
  was the only finding network the detector knew, so a stalker using a Tile was
  invisible to a device whose whole purpose is finding planted trackers. These
  three need no length trick like Apple's: no phone advertises them, so the
  service is the detection — Tile `0xFEED`, Samsung `0xFD5A` (registered in
  offline finding) and `0xFD59` (still in setup).
- **Google FMDN announces its own unwanted-tracking mode.** `0xFEAA` service
  data with frame byte `0x40` is a finding beacon; **`0x41` means the tracker
  has entered unwanted-tracking-protection mode** — it is signalling that it may
  be following someone. Eddystone shares `0xFEAA` with frame types
  `0x00`/`0x10`/`0x20`/`0x30`, so the frame byte is what separates a finding
  beacon from a shop beacon; those are not flagged.
- **Measured against our own captures:** the Tile arm fires on the bench Tile
  keychain (61 adverts across six captures on three days, up to -40 dBm) plus
  two more Tiles in the field, and one real FMDN tag appeared at -89 dBm with
  frame `0x40`. **The Samsung arm is spec-only** — no SmartTag has ever crossed
  a capture, and the code says so rather than implying it is proven.
- **What a Tile looks like, from 149 captures** (checked against lesleyxyz's
  node-tile protocol research). Every Tile advertises the `0xFEED` service
  UUID plus `0xFEED` service data: `02 00` and 8 bytes that change. The bench
  Tile, set up on an account and now separated from its owner, sent 2231
  adverts over three days on **one static address** at about one every 4 s.
  Field Tiles showed a new address every time. node-tile says a Tile that was
  never activated advertises `0xFEEC` instead; none of the 149 captures
  contains `0xFEEC`, so there is nothing to test that on yet, and the detector
  still alerts on any `0xFEED`. Skullcandy headsets with Tile built in (Crusher
  Evo, company ID `0x07C9`) advertise `0xFEED` too, and they list as Tile
  Tracker, which is correct: they can be found on the Tile network.
- **A Tile cannot be rung.** Ring needs an authkey that only the owner's Tile
  account hands out (a cloud login, then an HMAC-authenticated channel over the
  `9d410018`/`9d410019` characteristics). A tracker planted on you is on
  someone else's account, and SignalSweep will not log in to any cloud
  service, so there is no Ring button for Tiles and none is planned.

### Added — Apple devices say what they are

- **Continuity message types are decoded into a plain-language label**:
  "Apple: AirPlay target (TV/HomePod/Mac)", "Apple: AirPrint (printer)",
  "Apple: Handoff", "Apple: Watch (Magic Switch)", "Apple: tethering source
  (hotspot)". Nearby Info (`0x10`) goes further and reports the activity nibble:
  active with the screen on, idle, just used, video playing, audio while
  locked, on a call, driving.
- **It is a label, not a detection.** No confidence, no category — so these rows
  never beep, never appear while the filter is on, and never count toward
  Surveillance. Any real signature rule wins the name. The point is that the
  filter-off view stops being a wall of anonymous random MACs.
- **Unknown stays unknown.** Message types `0x01`, `0x13` and `0x16` are live in
  our captures (120, 11 and 196 distinct MACs) but appear in no published table,
  so they read "Apple device" rather than a guess. Likewise the Nearby Info
  activity codes outside the documented set.
- **Lid open/closed is deliberately NOT reported.** macOS stops advertising
  Nearby messages when the lid shuts, which is indistinguishable from powered
  off, asleep or out of range — presence is not a state field, and a badge built
  on it would be a guess.
- Field meanings come from the furiousMAC Continuity project (GPL-2.0, so no
  code was taken — see `CREDITS.md`) and every value was cross-checked against
  our own captures.

### Fixed — The screen stays on for the whole cable connection

- **The wake lock now covers the entire USB/serial connection, not just a
  capture.** It is taken when the cable connects (the same place the `CMD:HOST`
  keepalive starts) and released on disconnect; a capture ending no longer drops
  it while the cable is still in. With the screen off the USB stream stalls and
  the live list goes stale, capture or not.
- **The lock is re-requested after the screen has been off.** Android releases a
  screen wake lock when the page hides, without telling the page, and the old
  code still held that dead object — so `!capWakeLock` blocked every re-request
  and, after one screen-off, the phone timed out mid-capture. The page now forgets
  the lock on hide. Measured on the OnePlus 7T (60 s screen timeout): a 180 s
  capture left untouched stayed awake throughout, 7157 records, zero sequence
  gaps; a 90 s capture with the screen forced off from 20 s to 50 s kept a flat
  380–465 records per 10 s with zero gaps, and re-took the lock on wake.

### Fixed — Neither board leaks heap while it scans

- **The S3 had the same leak, and worse: `setMaxResults(0)` now applies to both
  boards.** The fix first landed inside the `CONFIG_IDF_TARGET_ESP32C5` branch,
  which meant the S3 never got it — and NimBLE 1.4 has the identical `0xFF`
  default and the same clear-on-completion behaviour. A 17 h 35 min S3 soak:
  internal heap 187.6 KB → 78.1 KB, **-6.25 KB/h**, dead straight, with the
  tracked-target count flat at 41–44 throughout. At that rate an S3 wired into a
  vehicle exhausts its internal heap in about 29 hours. It never crashed during
  the run, which is the point: a leak this steady fails silently and late.
  With the fix, a 10 h 35 min soak of both boards measured **+0.04 KB/h on the
  C5** (flat) and **-0.78 KB/h on the S3** — an 8x improvement, zero restarts on
  either board. The S3's remaining drift is small and steady (191.2 → 182.9 KB
  while the target count *fell* 34 → 29), which is roughly nine days to
  exhaustion rather than 29 hours; the rest is a known, tracked follow-up rather
  than a mystery. Only the shared scan setup is common, so the C5's
  bench-measured interval/window stay inside the `#if`.
- **`setMaxResults(0)` on the C5 scan.** NimBLE 2.x keeps every scan result by
  default (`0xFF`), and the results are only cleared when a scan *completes* —
  the detector's scan never does, because it runs continuously. Every rotating
  random MAC therefore added an entry that was never freed. Measured over a
  5 h 20 min soak logging `heap_caps_get_free_size(MALLOC_CAP_INTERNAL)` once a
  minute: internal heap fell 96.0 KB → 71.0 KB, still falling in a straight
  line, while the tracked-target count stayed 57–88 throughout — so it was not
  target churn. With the fix, 94.1 KB free at 18 min with 65 targets, against
  91.2 KB for the old build at the same point. `0` means callbacks only; a
  scannable device is still held until its scan response arrives, so the names
  the signature rules match on are unaffected.
- **The measurement only works on `MALLOC_CAP_INTERNAL`.** `esp_get_free_heap_size()`
  includes 8 MB of PSRAM and hid the leak completely — an earlier 16-minute run
  read the wrong number and concluded nothing.
- **Still open: an unexplained reboot.** The C5 has restarted on its own twice
  (`esp_reset_reason()` = 4, a panic) with ~85–89 KB free, so it is not
  exhaustion. Longer soaks logging the full serial output are needed to catch
  the backtrace.

### Changed — Ring shows up only where it can work

- **Ring is offered only on devices that advertise Immediate Alert (`0x1802`)
  or Link Loss (`0x1803`).** Ring writes the standard Alert Level
  characteristic, which only Find Me / Proximity keyfobs have. AirTags need the
  owner's key to play a sound, Tiles speak their own protocol and phones ignore
  it, so the button that sat on every Bluetooth row almost never did anything.
  The detector remembers the flag per device and sends `"ring":1` on those rows
  only. A tag that has the service but does not advertise it gets no button.
- **Ring connects with the address type it heard.** It always connected as a
  random address, so every keyfob with a public address failed before the
  write was attempted.
- **The toast reports what happened.** The board answers
  `{"ring":"<mac>","ok":true|false}` after the attempt, and the app says
  "Ring landed" or "Ring failed" instead of an unconditional "Ring sent".

## [0.4.0] — 2026-09-16 — Every Wi-Fi row says where, and a router is one row

### Fixed — Hunting over the cable

- **The hunt meter updates as fast on USB as on Bluetooth.** The 3-per-second
  hunt frame went out over Bluetooth only, so a phone or laptop on the cable
  saw the target's signal once a second. It is now mirrored to USB like the
  1 Hz push. Measured on the bench: 0 hunt frames over USB before, 2.1/s on the
  ESP32-S3 and 1.3/s on the C5 after.

### Added — Band badges, and one row per box

- **Every Wi-Fi row says where it was heard:** `2.4G · ch 6` or `5G · ch 36`.
  The board reports the last channel per target (`"ch"`, Wi-Fi rows only, a few
  bytes each), so the XIAO ESP32-C5's 5 GHz coverage is readable at a glance.
- **A dual-band box is one row.** Wi-Fi transmitters whose MACs share the first
  five octets with last octets within 4 fold into one row that shows every band
  it was heard on and how many radios; tap to see each radio with its own Hunt.
  On C5 field captures about a third of 5 GHz-only transmitters were the second
  radio of a box already heard on 2.4 GHz. Rows are never joined on network
  name: mesh networks and hotspots share SSIDs across unrelated hardware.
- **A router's extra networks fold in too.** Guest, IoT and hotspot SSIDs on one
  radio use MACs whose last five octets match and whose first octet differs with
  the locally-administered bit set; they join the row when their channels agree.
  On six C5 field drives that rule found 941 groups, all with at most one
  non-local MAC, and 3 channel mismatches (refused). Both rules together took
  6886 transmitters down to 3665 rows; next to one router on the bench, 33 radios
  became 12 rows.

### Changed — Install tidy-ups

- `install.py` speaks esptool 5's `chip-id` / `write-flash` (the old spellings still
  work on esptool 4), so installs no longer print a deprecation warning.
- `install.py --from-dir _site/firmware` reads the version from the site's
  `manifest.json` one level up instead of titling the run "local build local".
- `site/assemble.sh` finds `boot_app0.bin` with `find -print -quit`: a
  `| head -1` under `pipefail` could fail a clean build on SIGPIPE.
- **"Updates lost" means lost telemetry again.** Opening the cable resets the
  board, and its boot banner counted as dropped pushes, so the badge read "29% of
  updates lost" after a clean connect. Only a line that looks like JSON counts
  now, and the counters reset with each link.
- The app links its favicon; every cold start used to 404 on `favicon.ico`.
- The C5's "5 GHz channel rejected" warning fires once per detector run instead
  of once per boot, so it speaks up again after a Site Survey capture.
- `analyze-capture.py` counts per-band MACs from management and data frames only,
  skipping multicast senders and out-of-range channels. With 5% of payloads torn
  it reported 52/23 MACs; it now reports 43/14, matching the clean capture.
- `install.py`'s missing-APK error names the folder you gave it.

## [0.3.0] — 2026-09-16 — The C5 hears 5 GHz, and installs like the S3

### Added — Install the C5 like the S3

- **One Install button, both boards.** The flasher manifest carries an ESP32-C5
  build beside the S3 one and ESP Web Tools picks by the chip it finds. The C5
  bootloader sits at `0x2000`, not `0`; `test_distribution.py` pins every offset
  to `partitions.csv` so the two can never drift.
- **`install.py` asks the chip.** Both boards share Espressif's USB id, so the
  port cannot tell them apart and the wrong image bricks the board. esptool reads
  the chip; `--board s3|c5` overrides and a mismatch aborts. `--from-dir` installs
  a local build or CI artifact. Releases before v0.3.0 have no C5 files, and the
  installer says so before touching hardware.
- **CI builds the C5 from the tagged commit**, in its own PlatformIO core dir (the
  two frameworks share a package name), with the Seeed platform pinned to the
  bench-proven commit and ESP Web Tools pinned to 10.4.0.
- `flash.py --board c5` sets the core dir and the UTF-8 output encoding for you.

### Fixed — Connecting and capturing recover on their own

- **One tap on OK now connects over USB.** The USB plugin's `requestPermission`
  always answers `granted:false` on Android 12+: its PendingIntent is
  `FLAG_IMMUTABLE`, which strips the `EXTRA_PERMISSION_GRANTED` extra it reads.
  Measured on a OnePlus 7T (API 36): tap OK, get `granted:false`, and
  `hasPermission` is true a moment later. The app believed the flag, toasted
  "USB permission denied" and stopped, so every first connect needed a second
  tap. It now asks the USB manager (`UsbSerial.hasPermission`) instead.
- **Back no longer strands the connection.** Back called `App.exitApp()`, which
  finishes the Activity but not the process: the BLE link and the USB port
  outlived the page. The reopened app showed "disconnected", the board (still
  connected, so no longer advertising) never appeared in the picker, and only a
  force stop got you out. Back now calls `App.minimizeApp()`, the same as Home.
- **A still-open BLE link is re-adopted.** `reconcileConnection()` queried
  connected devices before `BleClient.initialize()`, so on every fresh page it
  threw "Bluetooth LE not initialized" and gave up. It now initializes first,
  connects through the fresh plugin instance (already-connected is success)
  and resubscribes, so a recreated page comes back connected with no tap.
  It only does this on a phone that has connected over BLE before, so a first
  launch never raises the Nearby-devices prompt.
- **A capture that never starts gives up.** One Site Survey capture sat at a full
  countdown with zero counters and a header-only file, because nothing on the
  phone ever stopped waiting. If no `{"cap"}` frame arrives within 5 s of Start,
  the app resends `CMD:CAP:START` once, then stops, deletes the empty file and
  says so. Repeated captures could not be made to stall on the bench (three
  back-to-back from a PC, two from the phone), so this guards the symptom; the
  original trigger is still unidentified.
- **A dead USB link is a disconnect.** The plugin discards its reader on a stream
  error; the app only logged it and kept showing "connected". It now disconnects,
  and a disconnect mid-capture ends the capture and keeps the partial file
  instead of leaving the countdown frozen.
- **The USB drain keeps up with the screen off.** It ran on
  `requestAnimationFrame`, which never fires on a hidden page, so a phone on the
  cable in a pocket queued every chunk unread (340 in a short doze on the bench)
  and then decoded the lot in one frame on wake, the same main-thread flood that
  once crashed a capture. A hidden page now drains on a timer; the queue held at
  5–6 chunks through 40 s of screen-off while pushes kept landing.
- **A disconnected strip stays cleared.** Chunks still queued from the closed port
  drained after the disconnect and repainted "Alerts since boot" with the old
  board's count. Closing the port now drops them.
- **The Site Survey no longer says 5 GHz is unhearable.** A miss is "cellular,
  which no SignalSweep board hears, or 5 GHz, which only the XIAO ESP32-C5 hears".

### Added — XIAO ESP32-C5 support (dual-band detector)

- **The detector runs on the XIAO ESP32-C5** (`pio run -e c5`), the first board
  that hears 5 GHz. Same pads as the S3 harness (LED bar on D1, buzzer on D2),
  BOOT on GPIO28. The S3 tiers are byte-identical: every C5 difference is behind
  `CONFIG_IDF_TARGET_ESP32C5`, gated by a preprocessed-source and image compare.
- **Radio settings are measured, not borrowed.** Side-by-side captures against a
  known transmitter picked: 2.4 GHz 1–11 plus the non-DFS 5 GHz channels at
  120 ms (DFS channels cost every other channel listening time); BLE scanning
  25 ms of every 50 (40/100 left three times the silent stretches on a 2-second
  AirTag; bursts left a 118-second blind spot); frames the C5 driver reports as
  failed are dropped (they were random bytes posing as thousands of devices).
- **Wi-Fi band select** (`{"band":0|1|2}`, Settings → Radios on the C5): both,
  2.4 GHz only or 5 GHz only, persisted on the device. The comparison numbers come
  from paired 10-minute field drives with the *capture* build (C5 and S3 recording
  side by side, torn records dropped): the C5 heard ~82% as many 2.4 GHz
  transmitters as the S3 — it spends time on 5 GHz — while finding ~35% more
  distinct transmitters overall across both bands and BLE. About a third of the
  5 GHz-only transmitters are the second radio of a device already seen on 2.4 GHz,
  so in physical devices the gain is nearer a quarter. The detector build's own
  field evidence is one 10-minute band-1 drive: zero frames above channel 14 in
  15,292 records, which is what proves the switch actually takes effect. A
  both-bands drive on the detector build has not been run yet. 2.4-only mode is
  there for when 2.4 GHz is all you care about.
- **Build trap:** the C5's Arduino 3.x framework package has the same name as the
  S3's 2.0.17 one. Build the C5 with its own `PLATFORMIO_CORE_DIR`, or the first C5
  build replaces the S3 framework for every checkout.

### Added — Themes: one pick sets the bar's colour and the buzzer's pitch

The Alerts sheet has a Theme strip under Lights: **Classic** (the default, and
exactly today's look and sound), **Night Ops** (deep red, held at Dim
brightness, half pitch — easy on dark-adapted eyes), **Terminal** (green
phosphor, double pitch), **Glacier** (cool blue, 1.5× pitch) and **Party**
(rainbow everything, a drifting rainbow idle bar, its own fanfare and
connect/disconnect arpeggios). Party gives up the quiet one-pixel heartbeat on
purpose, and the app says so under the picker. The board stores the theme
(`sweep-bz`/`theme`), takes `{"theme":0..4}`, and reports it in `CMD:CFG` and
unconditionally in the 1 Hz push, like the LED mode; the chips paint only from
those reports. Picking a new theme plays the boot sweep and chirp in it, so the
tap visibly does something.

How it stays an instrument and not a toy:

- **Under a theme, the animation's shape is the ID** (sweep, flash pops,
  rotors, sonar), and the jingle's rhythm is the ID by ear. Only colour and
  frequency change. The category rows now name shapes, not colours, so they
  stay true in every theme.
- **The recolour runs on the finished frame** (`applyTheme()`, after the frame
  is built and before the LED-mode step). Each pixel keeps its brightest channel
  and takes the theme's hue, so animation shape and hunt-meter length survive
  and no draw routine knows themes exist — new animations inherit them for free.
  It edits the brightness-scaled NeoPixel buffer directly, in GRB order.
- **Pitch lives in `buzzerTone()`**, the one door every sound goes through, so
  jingles, the hunt clicker and the siren all follow and no rhythm can change.
  Classic skips the scaling entirely; notes are clamped to 200–6000 Hz; rests
  never reach it.
- **One LED mode ignores the theme.** A single pixel has no shape, only colour,
  so it keeps Classic colours and the normal green/blue heartbeat. The final
  review caught Party under One painting a steady white dot instead (the Party
  idle fill was not gated), and Night Ops dimming it; both are now exempt.
- **Flashes stay Classic.** The BOOT-hold factory-reset warning is red on
  purpose and the siren strobe alternates; recolouring them turned "about to
  wipe" green under Terminal. `applyTheme` is skipped on `flashActive` frames.

Known edges, accepted: the preview is suppressed while a hunt target is being
heard (`geigerLocked`), not for the whole hunt, because the LED code cannot see
the hunt target; a preview interrupts an alert already playing, but only on an
operator tap; the Party fanfare plays as a preview, not at power-on (no theme
plays a power-on jingle). Night Ops' half pitch puts the hunt clicker at
250–1250 Hz, below a typical piezo's sweet spot — tune the multiplier if it
reads too quiet. Receive-only's blue heartbeat is a Classic-only cue.

`selftest.js` pins the `ThemeId` order to the app's `THEMES`, the push field,
that the chips are buttons, that `drawAnimation`/`drawHuntMeter` never mention
themes, that `applyTheme` runs before the LED-mode step and skips One and
flashes, that `buzzerTone` skips Classic, and the picker's notes. Bench: flashed
to the LED board and the phone, every theme picked and previewed on the bar.

### Fixed — Bluetooth Remote ID decoded a byte off, and the bench could not see it

A real Bluetooth 4 Remote ID advert carries UUID `0xFFFA`, the app code `0x0D`,
a **1-byte message counter**, then the 25-byte ASTM message — exactly 31 bytes.
`bleDecodeRemoteId()` skipped the app code but decoded from the counter, so every
field of a real drone came out shifted by a byte: junk serial, junk coordinates on
the map. Presence still alerted (a malformed decode still means "a drone is
broadcasting here"), which is why the beep looked healthy. The bench emitter hid
it: it sent the bare message with no app code and no counter, which took the
other branch. The emitter now uses real framing, and `selftest.js` fails if the
decode offset moves back onto the counter.

The two Wi-Fi paths (beacon vendor IE, NAN action frames) had never seen a frame
on hardware. The emitter gained `dronewifi` and `dronenan` personas built with
the upstream `odid_wifi.c` encoder, so the detector is tested against the
reference implementation rather than our reading of the spec. Bench, two boards:
all three paths decode `SS-TEST-DRONE-0001` at 37.33182 / -122.03118 with
altitude, speed, heading and operator position intact; Wi-Fi caught 5 of ~87
beacons and 10 of ~105 NAN frames across 25 s (the hopper is elsewhere most of
the time — a real drone sends ~10/s); 59 pushes in 60 s.

The channel hopper also grants a channel that just carried Remote ID one extra
dwell — never two in a row, so a drone overhead cannot park the hopper and blind
the other channels. Still out of reach on this hardware: 5.8 GHz Remote ID (the
S3 is 2.4 GHz only) and BT5 long-range adverts (`CONFIG_BT_NIMBLE_EXT_ADV` off).

### Changed — while hunting, only the hunt makes noise

Lock onto one device and it is now the only thing the board beeps or lights for:
the Geiger clicker owns the buzzer and the hunt meter owns the bar. Before, every
other match that walked into range still played its category jingle and
animation, and both outrank the hunt — the jingle stomped the clicker and the
animation covered the meter, on exactly the walk where you are listening to one
signal. `noteAlert()` now declines every category alert while a hunt target is
set, including the hunted device's own (the clicker already is its sound), and
`setHuntTarget()` drops an alert queued in the second before the lock.

Detection and listing carry on untouched, and a declined alert is not recorded,
so a target's once-per-appearance flag stays clear: stop hunting and anything
still nearby sounds once, which tells you what was around while you were busy.
Bench-verified with two boards and a name rule matching the target at -8 dBm:
39 pushes while hunting with `alerts` = 0, then 0 → 1 on the first push after
the hunt was cleared.

### Added — the Site Survey page (find signatures, build a database)

Capture, log-a-device and evidence export were scattered across Settings and the
Pins sheet; they are now one **full-screen Site Survey page** (🔎 header icon; first called "Device Finder", renamed because it read like Hunt) with a
top-to-bottom workflow: **1) Investigate** an environment (the capture, USB only),
**2)** the app **analyzes the `.sscap` on the phone** and surfaces the suspect —
it says Flock only under the detector's own rule, never on the IE alone (see below) — then
**3) Log this device**: a photo + the detected signature + the raw capture, into
an encrypted **finds database** listed right on the page. **Export evidence
bundle** decrypts it all (photos + OSM/CSV with the signature + the raw captures)
for DeFlock.

The on-phone analyzer is a JS port of `analyze-capture.py`'s core (self-test
`analyzerFlock` checks it against a hand-built Flock frame). The encrypted store
is now `{ pins, finds }` under one PIN, with transparent migration from the old
pins-only array (`v1Migration` self-test). Pins keep only "ask to pin matches"
and simple auto-pins; Site Survey owns the investigation side. The log is
**Survey log**; while it's locked the count reads 🔒, not a misleading 0. Export
lands in `Documents/signalsweep-evidence-<date>/` (Files app, USB, or `adb pull`),
and the page says so.

**Android can kill the app while the camera is up.** When that happens the shot
comes back through `appRestoredResult` to a freshly booted page that has lost the
PIN key and the analysis. `logDevice()` stashes the signature + capture name
before launching the camera, and the restored result goes through the same
`saveFindFromShot()` after an unlock, so the photo lands instead of vanishing.

**Photos were silently dropped until `b64()` was chunked.** Base64-encoding the
encrypted photo spread the whole byte array into `String.fromCharCode(...)`,
which overflows the JS call stack from about 0.5 MB up, and every real camera
shot is bigger than that. The save threw, and the log stayed empty. `b64()` now
converts in 32 KB chunks, and `photoRoundTrip` round-trips a 3 MB buffer, so a
regression fails the self-test instead of a field survey. Export shared the
same helper and is fixed with it.

**Every survey is in the Survey log.** The list reads the `.sscap` files straight
off the phone, newest first, so viewing needs no PIN and nothing new is stored.
Tap a survey to analyze it again and log a photo against it. Once the log is
unlocked, photos and locations appear under the survey they belong to, and ✕
deletes a capture from the phone.

**Log this device asks what it is.** Three buttons: Flock / ALPR camera, Other
camera, Not sure. Only a confirmed camera with a GPS fix becomes a node in
`cameras.osm` (`surveillance:type=ALPR` or `camera`). A Not sure photo stays in
the CSV and the log, so a guess never lands on OpenStreetMap. The choice rides
the camera-restart stash, and falls back to Not sure, never to a camera.
`findOsmTags` in the self-test holds the line. The app's `categoryOf()` now
tests ALPR before body cam, the same order the firmware relies on: "ALPR /
Camera" contains "cam", and those finds had been painting as body cams.

**Trap — the capture crashed the app until the USB stream was batched.** A
capture floods the app with USB `data` events, and the listener decoded + parsed
each one synchronously on the main thread. Under the flood that saturated the
thread and intermittently OOM-crashed the WebView renderer mid-capture — the
capture died, `capFinish` never ran, and nothing saved ("the capture didn't
save"). Fix: the listener now does O(1) work — push the raw base64 to a queue —
and a single `requestAnimationFrame` drain decodes the whole batch once per
frame, paced to the display so the thread breathes and the screen keeps painting.
Belt-and-suspenders: a screen wake-lock during capture (a screen-off would
otherwise background and kill it) and a 60k-record cap on the analyzer.

**Photo-survives-GPS:** logging a device now saves the photo and the find FIRST,
then fills in GPS in the background — a slow fix in the field never throws away a
good shot (the old flow aborted the whole log, photo included, if GPS was slow,
which is why three field cameras logged zero photos). A find with no fix yet still
lists and still exports its photo, signature and capture.

### Changed — field notes: we fingerprinted the Flock IE, then tried to break it

A parking-lot survey at three Flock cameras (2026-09-12) turned up random-MAC
probe requests at 0 to +5 dBm carrying vendor IE `50:6f:9a:16:03:01:03`, and home
captures had none. It looked like the modern Flock tell, so for one commit the
detector alerted on that IE alone, on any MAC. Then we did what separates a
signature from a superstition: we attacked it with every capture we had.

- **The loudest "camera" was our own survey phone.** Disconnected Android probes
  for WiFi on a fresh random MAC every scan. The OnePlus running the app sends a
  14-tag probe fingerprint (`0,1,50,3,45,127,191,221:0050f208…,255,127,255,`
  `221:506f9a16…,221:8cfdf0…,0`). **9 of the 10** strongest lot devices matched
  it tag for tag. On the bench, disconnected, it rotated through 13 random MACs in
  two minutes. At home it was connected and quiet, which is why the negative
  control looked clean.
- **The 7-byte IE isn't Flock's.** `50:6f:9a` is the Wi-Fi Alliance OUI, and
  `16 03 01 03` reads as the MBO cellular-capability attribute. An exact-bytes
  sweep of every capture found it on AzureWave, China Dragon and Guangzhou
  Shiyuan WiFi modules at -83 to -92 dBm: a neighbour's gadget, which a bench
  survey promptly called a camera.
- **Nothing camera-strength survived the diff.** Lot minus home minus bench,
  with the phone taken out, leaves -56 to -74 dBm passers-by. Whatever those
  cameras speak at that range, it isn't 2.4 GHz WiFi.

What ships:

- **The IE is a tightener again**, the way upstream (DeFlockJoplin) uses it.
  Listed Flock OUI + wildcard probe + IE scores `W_WIFI_IE_SIG` (rule "Flock
  probe + IE"); OUI + wildcard alone stays `W_WIFI_PROBE`. `selftest.js` fails if
  a standalone `if (liteonSig)` gate ever comes back.
- **Know thy own emissions.** Before a capture, Site Survey asks whether WiFi
  and Bluetooth are off on every phone you're carrying. It asks about Bluetooth
  alone if the phone is on WiFi (`navigator.connection.type`), because the phones'
  own Google BLE adverts (`FEF3`/`FCF1`) turn up in every capture, home and lot
  alike. Android won't let an app switch a radio off, so it asks. Each capture
  header records `phone_net=`.
- **No verdict the detector wouldn't give.** The on-phone analyzer calls a
  capture Flock only under the detector's own rule, a listed Flock OUI sending
  wildcard probes with the IE. Its OUI list is pinned to the firmware's by the
  self-test. A bench survey had flagged a China Dragon Technology module (public
  MAC, -77 dBm, wildcard probes carrying the IE) as a possible Flock; it now
  reads as nothing, and `analyzerFlock` holds both cases. `analyze-capture.py`
  keeps the IE as a labelled hint for digging on a PC.
- **A bar for the next tell.** Capture at the pole with every phone's radio off,
  plus a capture about 100 m away. A candidate has to be absent from every home
  and bench capture, and its full tag order must not match a phone. Random-MAC
  Flock detection stays open until something clears that bar.

### Added — environment capture (raw packet logging for the unknown)

The detector only reports what it already judged interesting, which is useless
when the signature is unknown — a modern Flock camera, for instance, that
rotates its MAC every few seconds and carries only the weak Lite-On IE, so it
never clears the alert gate and shows up (if at all) as one of dozens of
"Lite-On Vendor IE (weak)" rows. Field screenshots next to a known camera showed
exactly that: the strongest signals in the environment were random-MAC clients
carrying `50:6F:9A`, invisible to an OUI-based detector.

So there is now a **stationary capture mode**. Settings → Diagnostics → *Capture
environment* (USB cable only — the raw stream is far too much for BLE NUS). You
pick a duration, stand next to the suspect device, and the board logs **every**
WiFi frame (all types, all channels) and **every** BLE advertisement to a file
on the phone (`signalsweep-capture-*.sscap`), which you pull to a PC and run
through `firmware/tools/analyze-capture.py`. The analyzer ranks devices by RSSI
with offline vendor lookup, flags random MACs and the Lite-On IE, and — the key
view — **groups probe/beacon frames by their IE fingerprint**, so many random
MACs sharing one fingerprint reveal a single device rotating its MAC. It also
exports the WiFi frames to a radiotap pcap for Wireshark, and has a `--minus`
diff mode to subtract a "walked away" capture from a "next to it" one.

Design honesty, baked in: the ESP32-S3 hears **only 2.4 GHz WiFi and BLE**. If a
full all-channel capture next to a camera shows nothing that tracks it, that is
the finding — the camera is on 5 GHz or cellular, which this hardware cannot
hear. The tool makes that provable instead of a guess.

**Camera evidence, tied to the capture.** The capture-done screen now has *Log
this camera*: take a photo (`@capacitor/camera`), drop a one-shot GPS pin, and
save both **encrypted behind the same PIN as the pins** — the photo as its own
AES-GCM file (`signalsweep-photos/*.enc`, since a photo is far too big for the
localStorage pin blob), the pin linked to the `.sscap` you just took at that
camera. *Export evidence bundle* (in Pins, PIN required) decrypts it all to one
folder: photos, coordinates as OSM (DeFlock-ready) + CSV, and the linked
captures — a complete package for someone to come back, verify the camera is
real, and submit it. The photo crypto round-trip is covered by `selftest.js`
(`photoRoundTrip`). Honest limit surfaced in the UI: the OS camera keeps its own
temp copy of the shot; we encrypt what we store, we can't scrub the OS cache.

Implementation: `mode_capture.cpp` pauses the detector (a single promiscuous rx
callback can't be shared), copies frames into two lock-free PSRAM ring buffers
from the radio callbacks (no malloc/lock/Serial there, same rule as the
detector), and a drain task base64-streams them over USB. Ring overflow bumps a
drop counter that is reported every second, so "lose no packets" is honest:
nothing is lost silently, and you see the exact count if the air out-ran USB.

**Trap (cost a bench cycle):** the S3 time-slices ONE radio between BLE and WiFi,
so the BLE scan *window* is stolen directly from WiFi promiscuous time. The first
build set the BLE scan to a near-100% window and WiFi came back with **zero**
frames while BLE flooded. The scan window is now 40 % (`setWindow(40)`,
`setInterval(100)`), favouring WiFi as the priority target. Anything that runs
both radios at once lives under this constraint.

### Fixed — the detector could no longer beep at a Flock camera

The headline capability had gone silently dead, and nothing in the UI could show
it. Flock's detectable surface collapsed twice: the cameras' management AP was
deactivated around December 2025 (which killed the SSID path — our only Wi-Fi
signal strong enough to alert, `W_WIFI_SSID` 80), and BLE stopped working in
spring 2026 (killing the `flock` / `pigvision` / `fs_` name rules and the mfg-ID
rule). What a current camera still does is spam **wildcard 802.11 probe
requests** — a probe with a zero-length SSID IE, "any AP, answer me" — roughly
every 125 ms on every channel. We already parsed those frames and matched the
OUI, but an OUI on its own scores `W_WIFI_OUI` (30), below `CONF_LIST_MIN` (60):
the camera was tracked, never listed, and never sounded.

The fix combines the OUI with the *behaviour*, research from **DeFlockJoplin**
(via colonelpanichacks/flock-you, drive-tested in Joplin at 11 of 12 cameras with
2 false positives). A wildcard probe **from a listed Flock OUI** is two
independent facts at once, and now scores `W_WIFI_PROBE` (70) — enough to clear
`CONF_ALERT_MIN` on its own, which is the whole point. When the frame also
carries the Flock stack's exact Lite-On vendor IE payload (tag 221, length 7,
`50:6f:9a:16:03:01:03`) it scores `W_WIFI_IE_SIG` (80).

Two traps kept as comments in `mode_watchers_watch.cpp`, repeated here because
they are the ways this path silently breaks:

- **The wildcard signal is gated on the OUI's category being `Flock Safety`,
  specifically.** A wildcard probe alone is meaningless — *every phone in range
  sends them* — so without the gate the buzzer would fire on the whole street.
  And it must be the *Flock* category, not just any listed OUI: a Cradlepoint or
  Sierra router on a listed prefix sending a wildcard probe is not a camera, and
  scoring it as one is the same failure as the `bandOf()` bug that once reported a
  TV as a camera. A hint that names the wrong vendor is worse than no hint.
- **The FCS is already stripped** by `body_len = length - offset - 4` before the
  IE walk, which is why this needs none of upstream's retry-with-`(len-4)` dance.
  Don't "simplify" that subtraction away.

Deliberately **not** taken from upstream: its ~200-line IE-fingerprint builder
(TLV resync, phantom-overflow recovery, a signature string compared against one
hardcoded allowlist entry tied to a single camera firmware revision) — the seven
Lite-On bytes above are its discriminating core; and its **addr1 echo** path
(catch a sleeping camera via a nearby AP's reply), which upstream itself rates
tier 1 and false-positive prone. Our confidence model is a sum with no tier to
demote a noisy path into, so it would only poison the vendor label.

The default Flock OUI list was synced to @NitekryDPaul's 2026-07-16 revision:
added `14:b5:cd`, removed `f8:a2:d6` (he field-demoted it — it hits a Sony Media
Player, not a Flock device). `SIG_SCHEMA_VERSION` bumped to 6 so already-deployed
boards regenerate rather than keeping the stale set for ever.

## [0.2.0] — 2026-09-11 — Lights, a cleaner top, and tabs that choose what alerts

### Changed: a band tab picks what alerts, and what asks to be pinned

Picking **Cameras**, **Trackers** or **Drones** now makes the device beep and
flash for that category only; **Everything** (or tapping the selected tab again)
turns them all back on. A tab is a preset `beep_mask`, the same persisted mask
the Alerts sheet edits, so it survives a power cycle and the board keeps it
headless. Cameras covers ALPR, body cams and the generic vendor categories,
the same umbrella the list uses. The device still detects and lists every
category, and every band still counts what it hears. Only the beep and the
light are narrowed. When the app connects it opens on the tab that matches
the board's mask. A custom mix set in the Alerts sheet leaves the tab where it
is, and the toolbar shows it as "n/5".

The tab also sets which matches ask to be pinned, so looking for Flock cameras
no longer asks about every AirTag. The Pins sheet has its own picker to
override it. The pin filter is stored in the app, like the pins themselves.

### Changed — the top of the screen says which board, and the toolbar is two buttons

The header now names the board you are connected to and the link type
("SignalSweep666 · USB"). The name comes from `CMD:CFG`'s `ble_name`, so it
works over a cable too, where you would otherwise see only a port. The status
strip shows **Uptime** and **Alerts since boot** next to Location. Uptime comes
from a new `uptime` field (seconds) in `CMD:CFG`: the app asks once and counts
on from there. The alert count (`alerts`, the same counter `CMD:CFG` already
had) now rides the 1 Hz push so it ticks live. The idle push measured 132 B,
and a 60 s soak got 60 of 60 pushes. CPU, heap and chip temperature were left
out. CPU usage needs FreeRTOS run-time stats, which cost time on every context
switch. Heap never moves. The S3's die temperature is uncalibrated.

The toolbar is down to **Alerts** and **Filter**. The filter button used to
read "Filter: matches" unlit in its normal state and lit up when the filter was
*off*, which is backwards. It now reads **Filter: On**, lit green while it is
filtering, and **Filter: Off**, unlit, while showing everything. "Recording" is
now **Ask to pin matches**, a switch in the Pins sheet behind a new 📍 header
icon. The icon lights green while the switch is on, so an armed prompt is still
visible from the main screen. The sheet opens without the PIN; only viewing
saved pins asks for it. Signatures moved into Settings.

Connection gets its own bar inside the header card: the board and link on the
left ("SignalSweep666 · Bluetooth"), and a labelled button on the right. The
button is a red-outlined **Disconnect**, which asks first, or a cyan
**Connect**. It replaces a lone Disconnect button that sat on a row of its own
outside the card. An earlier draft made the name line itself tappable, with a ⏏
glyph, and nobody would have found it. The amber "Device disconnected" banner
is gone. Its Connect Now button duplicated the header's Connect, and its
message ("it still beeps on its own") is already what the empty list says.

### Fixed — turning the filter back on left the whole list up

After Filter went back on, every unmatched row stayed listed, with Hunt
buttons, until it aged out 8 s later. There were two causes. `liveRows()`
relied on the device no longer reporting those rows instead of hiding them
itself. And a push sent before the board applied the command still carried
`scan_all:true`: the app drew that push under the old mode and adopted the
state only *after* drawing. The list now drops unmatched rows at once while
the filter is on, the device's state is adopted before rendering, and a
disagreeing echo is ignored for 1.5 s after your own tap. After that the
device is the authority again, so a write that never landed still repaints
the truth.

While nothing is connected, Filter now reads "Filter: —", unlit, like Alerts,
instead of a confident "On" for a board the app cannot see. Tapping it says to
connect first, instead of flipping a setting no board would receive.

### Added — lights: off, one LED, dim, or full

The toolbar's Sounds sheet is now **Alerts**, in two sections: *How* (Sound
on/off and a four-way Lights picker) and *What* (the five categories). Lights:
**Off** (the bar never lights, boot sweep and BOOT-hold flash included),
**One** (only the first LED lights, in the frame's brightest colour, so the hunt
meter still reads red/yellow/green and each alert keeps its category colour),
**Dim** (the whole bar at about a sixth of normal brightness) and **Full**. It
is one post-processing step on the finished frame in `HardwareManagerTask`, so
every animation obeys it without knowing it exists. Set with `{"led":0..3}`,
saved in NVS (`sweep-bz`/`led`) so it survives power loss, and reported in
`CMD:CFG` and the 1 Hz push for the same reason as the buzzer mute: the app
paints the picker only from the device, so a lost write self-heals within a
second.

It is called Alerts, not Notifications, because on Android "notifications"
means the phone's notification shade, and this app posts none. The old Buzzer
row billed itself as a master mute that "silences everything below", and with
it off, the five rows under it still read ON. Both were half true: the buzzer
mute is sound only, while a category switch gates its beep *and* its light. So
each category row now shows what its alert will actually do given the two
outputs: 🔊 💡, 💡 (sound off), 🔊 (lights off), Silent (both off) or Off.
That label comes from `alertChip()`, which the selftest covers.

### Added — the cable chirps like the Bluetooth link

Connecting and disconnecting over USB serial (Android USB host or desktop
WebSerial) now plays the same rising and falling chirps as a BLE connect.
Plugging in a cable does not. The board cannot tell those apart by itself: the
USB-Serial-JTAG stack's "connected" only means a host is sending frames, which
is true the moment the cable goes in, and opening the port resets the board
anyway. So the app announces itself. It sends `CMD:HOST` every 2 s while it
holds the port (the first one chirps) and `CMD:HOST:BYE` on a deliberate
disconnect. If the keepalive just stops (cable yanked, app killed), the board
plays the disconnect chirp after 6 s. Other serial traffic, such as a terminal
or a bench script, never chirps. `node app/selftest.js` fails if either side
renames the two commands.

### Added — who made it, and which end of the Wi-Fi link it is

The detector always listed both Wi-Fi access points (beacons, probe responses)
and clients (probe requests), but the app drew both as the same "Wi‑Fi" chip.
The push now carries `"ap":1|0` for Wi-Fi rows and the chip reads **📡 AP** or
**📱 Client**; rows from older firmware keep the plain chip. Selecting the
Wi‑Fi tab opens a second strip, **All Wi‑Fi · 📡 APs · 📱 Clients**. It filters
only while Wi‑Fi is selected, so a choice left behind cannot silently hide rows
under Both or Bluetooth.

Rows also name their manufacturer, two ways. A globally-unique MAC is looked
up in the IEEE OUI registry. For BLE the push adds `"cid"`, the company ID from
the advert's manufacturer data (Apple is `0x004C`), plus `"pub":1` when the
address is public. The company ID is what makes BLE work at all: most BLE
addresses, and most modern phones' Wi-Fi probes, are randomized. A random
address has no vendor, and running it through the OUI table anyway gives a
confident wrong answer. Such rows say "random MAC" instead. Where both lookups
apply, the IEEE registry wins, because a company ID is self-declared. Govee's
Telink thermometers send `0x0001` (Nokia) on public Telink addresses, so the
company ID is only used for random addresses and "Private" registrations.

Both lists ship with the app (`app/public/oui.txt`, `app/public/bt-company.txt`,
refreshed by `app/tools/fetch-vendors.mjs`) and are looked up offline. **Never
switch this to an online OUI API.** That would send every MAC the device hears
to a third party, which is the passive trail this project exists not to leave.

### Changed — the LED bar speaks, and stops shouting when idle

Every indicator used to `fill()` the whole 8-LED bar with one colour, a holdover
from a single status pixel. Idle, that meant all eight LEDs blinking every
0.8 s: obnoxious on a desk, and on a counter-surveillance tool in a parked car
a beacon. Idle is now **one dim pixel** that glows up and down once every 4 s
(green, or blue in receive-only) -- enough to tell alive from unpowered.

The full bar is reserved for detections, and each category gets its own
animation, because like the buzzer pattern the shape *is* the ID and must read
with the buzzer muted: ALPR a red comet sweeping end to end twice, body cam
three camera-flash pops in the long-short-short rhythm, drone a rising fill
then two "rotor blades" chasing round, tracker four alternating ticks then two
sonar pings from the centre, unknown match an amber breath. While hunting the
bar is a steady RSSI meter read like a phone's signal bars -- the count is the
strength, and the whole meter goes red (below ~-71 dBm), yellow, then green
(above ~-50, about a metre from a BLE tag) -- replacing a 25 ms full-bar
magenta flash on every Geiger click. Power-on is a rainbow wipe. The meter was
first coloured by position like a heat gauge, green first and red last, which
painted a weak -76 dBm lock as four green bars: "good signal". The
meter first flared on each click too, and at 2-3 clicks a second that was hard
to look at -- the ear already has the clicks. It also hopped a whole LED on
every advert, because RSSI jitters several dB packet to packet, so the level is
smoothed over about a second and the top LED lit in proportion: it glides.

Frames are drawn every task tick and pushed to the strip only when the pixel
buffer changed (`memcmp` against the last frame), so a static idle costs
nothing on the data line. Measured on the two-board bench: 30 pushes in 30 s,
unchanged. The bar these boards use is RGB (WS2812B, `NEO_GRB`) -- verified
clean on hardware; a true RGBW bar would need `NEO_GRBW` or every colour and
position comes out scrambled.

## [0.1.1] — 2026-09-06 — A signed APK, and an installer that checks first

### Added — the Android app is published

There was no distribution path for the app: no signing config, so a release
build produced an unsigned APK, which Android refuses to install. It is
sideload-only and will stay that way -- there is no Play Store listing -- so
the release asset has to be a properly signed APK. CI now builds and attaches
one on `v*` tags, signing it from a keystore held in repo secrets and running
`apksigner verify` before publishing. `versionCode` is derived from the tag
(`major*10000 + minor*100 + patch`), because Android requires it to strictly
increase on every upload and deriving it means that cannot be forgotten.

Local and fork builds are unaffected: without the keystore they produce an
*unsigned* APK rather than a debug-signed one. That is deliberate. A debug key
is generated per machine, so the next build would sign with a different one and
the upgrade would fail with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, whose only
fix -- uninstalling -- destroys the user's encrypted pin store.

### Added — `install.py`

Downloads a published release and puts it on hardware: firmware, app, or both.
Separate from `flash.py`, which builds from source and needs a toolchain.

Because it points destructive tools at devices, it refuses to guess. More than
one board or phone attached means it lists them and makes you choose; it prints
exactly what it is about to do and waits for the target's name to be typed
back. Every download is verified against the sha256 GitHub publishes for that
asset before anything is flashed -- a truncated image bricks a board until it
is reflashed. `--erase` is opt-in and says first that it wipes the mute, beep
mask, hunt target, BLE name and signature rules. An install signed with a
different key is explained in plain language instead of an adb error code.

### Fixed — every PNG in the Android project was committed corrupt

There was no `.gitattributes`, `core.autocrlf=true` on Windows, and git
normalised CRLF->LF *inside* the binaries on commit. All 26 were stored with
the signature `89 50 4E 47 0A 1A 0A` -- missing the `
` that PNG puts there
precisely so this is detectable -- and every other `0D0A` in the image data
stripped too. Not reversible.

`aapt2` rejects them ("file failed to compile"), so **no APK could be built
from a clean checkout**. It went unnoticed because local builds reused cached
compiled resources from before the corruption. `.gitattributes` now marks
binaries, and the icons are regenerated from `app/assets/*.svg` -- the app's
own brand mark, so the launcher icon finally matches the app.

### Verified

Signing proved end to end with a throwaway keystore: `apksigner` reports a V2
signer, `versionCode` 101 from `versionName` 0.1.1, the installed package shows
`flags=0x0` (not debuggable), and it launches. A clean `assembleRelease` now
succeeds where it previously failed on resources. `install.py` was tested
against the live v0.1.0 release: four sha256 digests verified, two attached
boards forced a choice, a wrong confirmation aborted without touching anything,
settings survived a flash without `--erase` and were reset by one with it, and
the signature-mismatch path was caught live against a phone's existing build.

One bug found by that testing and fixed: `--erase-all` was placed before the
`write_flash` subcommand, so esptool rejected it and the erase never happened.

## [0.1.0] — 2026-09-06 — Sounds you can find, and that stay in sync

### Fixed — overlapping BLE writes silently dropped commands

GATT permits one write in flight; a second is rejected with `InvalidStateError`
and, because nothing awaits `sendCommand()`, the command was simply lost behind
a "BLE Transmit Error" toast. Ordinary use reached this: the five per-category
sound toggles each fired their own command, so muting a few categories quickly
raced the writes against each other. `sendCommand()` is now a one-deep promise
chain over `sendCommandNow()`, with the same handler on both arms so a failed
write cannot strand everything queued behind it. Bench-verified: five rows
tapped as fast as `adb` can issue taps, zero transmit errors.

### Fixed — the app and the device drifted apart with no way back

`beep_mask` and `buzzer` were reachable only through the `CMD:CFG` reply, which
the app requests three times on connect and then never again. One dropped write
or one dropped notification left the phone painting a mask the board did not
have, for the rest of the session — recoverable only by a five-second factory
reset and a force stop of the app. Both fields now ride the 1 Hz push
(unconditionally: "absent" must not mean both "the default" and "old
firmware"), and `syncDeviceState()` adopts them, so a lost write self-heals
within a second. Measured cost: idle push 84 → 113 B, still 60 pushes in 60 s.

Verified on the bench by changing the mask over USB behind the app's back — the
phone repainted itself, including reverting a mute the app itself had set, with
no interaction.

### Fixed — the toggles owned state the device was supposed to own

They were `<input type="checkbox">`. A checkbox flips on tap, before the write
is attempted and regardless of whether it lands, so the box could show a mask
that never reached the board. They are now buttons painted solely by
`setBeepUi()`/`setBuzzerUi()` from device frames, and `app/selftest.js` fails
if an `id="beep-*"` element becomes a checkbox again.

`toggleBeep()` chains off `pendingMask` — the mask last *asked for* while still
in flight — rather than the last confirmed one. Computing every tap from the
confirmed value made taps inside the echo window overwrite each other: five
quick taps that should have muted everything left two categories sounding
(measured). Intent expires after `PENDING_TTL_MS` so a write that never lands
leaves no phantom for later taps to build on.

### Changed — the sound controls moved out of Settings

The five category toggles were three taps deep in the Settings modal, below a
scroll. They now live in a **Sounds** sheet opened from the toolbar, which also
carries the master mute and reads its own state at a glance
(`🔊 Sounds: 4/5`, `🔇 Sounds: off`). Silencing a category is a field action.

### Fixed — the firmware could report a mute it was not honouring

`isBuzzerEnabled()` returned `true` when it could not take `hwMutex` in 50 ms,
so a muted board reported itself audible — and `setBuzzerEnabled()` set the RAM
flag inside the mutex while writing NVS outside it, so a timeout left a board
that beeps now and boots silent later. The audio task takes that mutex every
loop, so neither was hypothetical. `buzzerEnabled` is now `volatile` and lives
outside the lock; only `buzzerOff()` still takes it.

### Fixed — "Surveillance Camera" sounded the body-cam pattern

`alertCategoryFromName()` tested `"cam"` before the ALPR terms, so any category
naming both resolved to `ALERT_BODYCAM` and was silenced by the wrong toggle —
indistinguishable from the mute not working. The shipped defaults dodge it; the
signature list is operator-editable and the UI labels that bucket
"ALPR / camera".

### Verified on the two-board rig

60 pushes in 60.3 s with the echo added. Mask and mute both survived a reboot.
With every category muted the alert counter did not move in 25 s while the
test transmitter broadcast; un-muting drone made it climb. Recorded audio confirms the
patterns are distinct and that muting is real silence: 0 bursts with mask 0, four
2000 Hz ticks for tracker, two 1200 Hz bursts 390 ms apart for ALPR (the piezo's
3rd harmonic dominates the spectrum, the fundamental measures 1200.0 Hz), and a
rising sweep ending at 2297 Hz for drone against a coded 2300 Hz.

## [0.1.0] — 2026-09-03 — The device is the authority on its own state

### Fixed — the buzzer mute never survived a power cycle

`hardware_manager.cpp` read `sweep-bz`/`on` at boot and **nothing anywhere ever
wrote it**, so `{"buzzer":false}` lived only in RAM. A detector muted in the
field came back beeping at the next ignition cycle — the one operator setting
that broke the rule every other setting follows. `setBuzzerEnabled()` now
persists it, outside `hwMutex` (the audio task takes that mutex every loop and
an NVS write must not be held against it).

### Fixed — the app guessed at the mute instead of asking

The mute was absent from `CMD:CFG`, so `app.js` shipped `let buzzerOn = true`
and a hardcoded `🔊 Buzzer: ON` button. Connect to a board that had been muted
headless — or to the second board on the bench — and the app confidently showed
the wrong state. `CMD:CFG` now reports `buzzer`, the `{"buzzer":…}` command
answers with a fresh config (as `beep_mask` and the radio toggles already did),
and the button paints `—` until the device says otherwise. `toggleBuzzer()` no
longer paints optimistically: if the command never lands, the button must not
claim it did. Both controls reset on disconnect, so one board's settings are
never shown as another's.

`app/selftest.js` now fails if the firmware reports a `CMD:CFG` field the app
never reads. A field the device reports and the phone ignores is state the phone
then invents; `buzzer` had been exactly that for the life of the project.

### Added — `CMD:SIGS`, so the signature editor stops overwriting rules blind

`getWatchersSignaturesJson()` existed with **zero callers** — no command reached
it. The editor opened blank against any board, and saving replaced a rule set
nobody had ever seen. It is now readable: the modal requests the rules on open,
shows what the board is actually carrying, and keeps Save disabled until they
arrive. On demand only, never on connect — the reply is multi-KB and the 1 Hz
push is the tightest budget on the device.

### Fixed — replies were lost on every transport except BLE

`sendBleSerial()` returns early when no BLE client is subscribed, so a reply sent
through it alone simply vanished on a board reached over the USB cable — one of
the app's three transports, and the one used on the bench. Replies now go
through `sendReply()`, which mirrors to `Serial` the way `sendConfigReply()`
always had.

### Fixed — a muted boot flooded the telemetry mirror with LEDC errors

Making the mute persist made a muted boot possible for the first time, which
exposed an old latent bug: Arduino attaches the LEDC channel lazily on the first
`tone()`, and `noTone()` on a channel that was never attached logs an error on
every call. A board that boots muted never calls `tone()` at all. Measured on
COM3: **561 LEDC errors in 4 s booted muted, 0 booted audible.** All buzzer audio
now goes through `buzzerTone()`/`buzzerOff()`; `buzzerOff()` no-ops until a
`tone()` has actually run, and `buzzerTone()` sets that flag *after* `tone()`
returns (setting it first left a race worth one stray error per mute
transition).

### Changed — the config handshake survives a dropped notification

BLE notifications are unacknowledged and the app asked for the config exactly
once, 400 ms after connect. One dropped reply left every settings control
painting a stale or default value for the whole session, silently. It now asks
at 400 ms / 1.5 s / 4 s until one lands, then stops.

Bench (two boards, COM3 + COM4, both tier1): mute survived a power cycle in both
directions; the two boards held independently different state across reboots
(A muted + filter on, B audible + filter off); `CMD:SIGS` returned 52 rules at
schema v5; a 60 s soak measured 60 pushes, 0 LEDC errors and `alerts=8` against
a bench transmitter.

## [0.1.0] — 2026-09-03 — Choose which categories are worth a beep

### Added — detection verified against a controlled signal

Detection is now tested against a bench transmitter we control rather than
whatever happens to be in the air, so "the detector works" stops being an
unfalsifiable claim. The transmitter is a local test fixture and is not part of
this repository.

Bench result: with the beep mask set to drone-only, the detector listed the
Flock and the AirTag but sounded only the drone — the two features verified
together on real hardware.

### Added — a per-category beep mask, in Settings and in NVS

Driving with the detector on, every AirTag in traffic earned the tracker
pattern. Correct behaviour, useless to listen to. Settings now has a **What
beeps** section: five checkboxes, one per buzzer "word" (ALPR/camera, body cam,
drone, tracker, other matches).

The choice lives on the device, not in the app — the whole point is headless
operation — as one bitmask over the existing `AlertCategory` enum
(`{"beep_mask":N}`, echoed by `CMD:CFG`), persisted in `sweep-st`/`beepmask`
next to the hunt target and the report filter, so a board wired into a car comes
back from every ignition cycle still muting what it was told to mute.

A muted category is fully silent: no beep, no LED flash, and no increment of the
`alerts` counter that proves the headless path works. It is still detected,
still tracked and still listed in the app — the mask is about the noise, never
about what the detector watches for.

`noteAlertForTarget()` now only burns its once-per-appearance flag when the
alert actually sounded. Otherwise un-muting trackers while the AirTag was still
in range would have stayed silent until the target aged out.

`app/selftest.js` cross-checks `BEEP_BITS` in `app.js` against the
`AlertCategory` enum in `hardware_manager.h` — a shared bit order that drifts
would mute body cams when you unticked trackers, with nothing at runtime to say
so.

Bench (two boards, COM3 detector / COM4 transmitter, rule matched on device name):
mask = drone-only with a Tracker-category rule → board listed, zero `[ALERT]`
lines, `alerts` 0; same mask with the rule recategorised as Drone → `[ALERT]
category=2 weight=70`, `alerts` 1 (proving the muted pass had not burned the
flag); `beep_mask` still 4 after a reboot.

## [0.1.0] — 2026-09-03 — A Settings page you can reach the bottom of

### Fixed — modals were not scrollable at all

`.modal-overlay` is a fixed 100vh flexbox and `.modal-card` had no `max-height`
and no `overflow`, so any modal taller than the screen spilled off both ends
with nothing to scroll. Settings is the tallest and showed it first, but Help
and Signature Rules had the same bug on a phone.

The overlay is now the scroller, not the card — the close button is absolutely
positioned *inside* the card, so scrolling the card would have pinned the x over
the content. `align-items:flex-start` plus `margin:auto 0` on the card keeps a
short modal centred and lets a tall one scroll, with safe-area padding top and
bottom. Escape and a backdrop click now close any open modal: the x can scroll
off the top, and a modal you have to scroll needs a way out that does not depend
on scrolling back up.

### Changed — Settings reads as one page instead of four inline-styled fragments

The body was wrapped in `.modal-actions` (`flex-direction:column; gap:1rem`), so
every element got a gap *plus* its own margin and no two sections agreed on
spacing. Each row and button carried its own duplicated inline style blob. All of
that is now five small classes — `.set-label`, `.set-note`, `.set-row`,
`.set-toggle`, `.set-text` — and one spacing rule. The header subtitle said
"Radios" while the modal also held Emissions, Identity and Opsec. Every id is
unchanged; `app/selftest.js` cross-checks them against `app.js`.

### Added — the radios report their own state

The BLE and WiFi ON/OFF button pairs were fire-and-forget: nothing anywhere said
whether a radio was actually paused, so both buttons always looked identical and
the modal could never show what the device was doing.

`CMD:CFG` now carries `ble_scan` / `wifi_scan`, and each `CMD:BLE_SCAN:*` /
`CMD:WIFI_SCAN:*` answers with a fresh config reply, so the app shows one
state-bearing toggle per radio painted from the device — the same
device-is-the-authority rule as `hunt`, `scan_all` and `rx_only`.

The flag is set in the command handlers, deliberately **not** inside
`pauseBle()`: `performRing()` pauses the BLE scan for the length of a ring, and
reading the state from there would report the scanner as off every time you rang
a tracker. Bench-verified on COM3 — 342 `CMD:CFG` samples taken across a ring
with `ble_scan` true throughout, both radios back to scanning after a reset.

### Fixed — the `scan_all` documentation was backwards

`CLAUDE.md` claimed the foxhunt filter was not persisted and that "a reboot
always comes back quiet". `setScanAll()` has always called `persistState()`, and
`restoreWatchersState()` reads it back. The code is right — the foxhunt workflow
is unplug-and-walk-away, and a filter that reset on a battery swap would only be
usable while tethered to the laptop you were leaving. The docs now say so, along
with the consequence: a board can come back still unfiltered, which is why the
filter-off list is capped at 18 rather than 40.

---

## [0.1.0] — 2026-09-03 — The phone can drive the device over USB

### Added — native USB serial on Android

Receive-only had a hole in it: silencing the device from the phone severed the
only link the phone had. The cable was not an option, because **Android has no
WebSerial** — the API is absent from the platform, not gated behind a flag —
and tapping the USB option on a phone did nothing but raise an alert.

That was the wrong conclusion to draw. The browser API is missing; the
capability is not. Android has USB host, the board is a CDC/ACM device
(`ARDUINO_USB_CDC_ON_BOOT=1`, Espressif VID `0x303A`), and
`usb-serial-for-android` has driven that class for years. The app now reaches it
through `@leeskies/capacitor-usb-serial`.

Plug the device into the phone with a USB-C cable, accept Android's permission
prompt, and you get full telemetry and full command control **with the radio
completely quiet**. That is what the emissions work was for.

Verified on the bench: with board A on the phone in receive-only, the witness
board saw it in 0 of 43 pushes while 99 telemetry events arrived over the cable
in the same window.

No firmware change was needed — `loop()` already read USB serial commands and
the detector already mirrored every 1 Hz push to `Serial`.

### Changed — receive-only is a toggle, not a one-way door

Over Bluetooth, going quiet severs the link that carried the command, so the
only way back is the BOOT button. Over a cable **nothing is severed**: the radio
goes quiet and the wire keeps working. A control that could only ever silence
would strand the operator in the one situation where recovery is trivial, so the
button now reads **Go quiet** or **Advertise** depending on what the device last
reported, and the warning text only threatens to drop the connection when the
connection is actually Bluetooth.

### Fixed — connecting over USB could silence the device without asking

The first cut asked "turn advertising off while you are on the cable?" the
instant the port opened. On Android that put a dialog in the same screen region
as the system USB-permission dialog, milliseconds after it — so the tap that
granted permission carried straight through onto its OK. Measured on the bench:
`{"rx_only":true}` went out 100 ms after connect with no human input, and the
detector went silent because someone plugged in a cable.

Silencing the detector is a deliberate act and it now lives only behind the
deliberate control in Settings. Connecting says so in a toast instead.

### Fixed — the USB option is offered where it can work

The button was hidden wherever `'serial' in navigator` was false, which is every
Android build. It is now shown wherever *any* USB transport exists — WebSerial
in a desktop browser, the USB host stack on Android — and the badge says which.

## [0.1.0] — 2026-09-03 — Receive-only: the detector stops announcing itself

### Added — receive-only mode

A counter-surveillance tool that advertises "SignalSweep" on the air announces
its presence to anyone else running a scanner, including the hardware it exists
to find. Receive-only stops advertising and drops the connection, leaving the
BLE radio doing nothing but listening.

The driver is emissions, not airtime. The scanner already runs a 50% duty cycle
and the real contention is Wi-Fi promiscuous against the BLE scan on one shared
radio, so shutting down the GATT server buys very little there. It buys the
whole answer to "does this thing broadcast?"

**It is not the buzzer mute, and it is not deaf.** "Silent" already means
`{"buzzer":false}`, which is untouched: the detector keeps scanning, keeps
matching, keeps sounding its per-category patterns, and keeps mirroring
telemetry to USB. Active scanning stays on too — scan responses carry device
names and the name-matching rules depend on them, so going fully passive would
blind the detector to save one packet.

Turn it on from **Settings → Emissions → Go quiet**, or with `{"rx_only":true}`
/ `CMD:RXONLY:ON` over serial. The setting survives a power cycle, so a board
left quiet comes back quiet.

### Added — three ways back in, so lockout is impossible

- **Tap BOOT** on the device: advertises for two minutes, then goes quiet again
  on its own if nothing connected. An accidental press in a pocket must not
  leave the board broadcasting all afternoon. Connecting inside the window
  un-quiets it properly.
- **`CMD:RXONLY:OFF`** over USB serial.
- **Hold BOOT for 5 seconds**, the existing factory reset, unchanged.

This is also why there is no Android USB-serial control path: Web Serial does
not exist on Android, and the button removes the need for a cable.

### Added — connecting over USB asks whether to go quiet

On the cable there is no reason to keep broadcasting, but it is the operator's
call rather than an automatic one. Quieting on any attached USB host would make
a board on a bench port permanently unreachable by phone.

### Added — you can see that it is quiet

Receive-only is invisible by definition, and a device that appears broken is
worse than one that is. The idle blink goes dim blue instead of green, with the
existing chirps on entering and leaving.

### Fixed — going quiet would have re-advertised immediately

`ServerCallbacks::onDisconnect` restarted advertising unconditionally, so
dropping the client on the way into receive-only would have put the device
straight back on the air — broken in the one way nothing in the interface could
have shown you. It is now gated. Proven on the two-board bench: with board A
quiet, board B saw zero of 63 pushes containing A, while A went on detecting B
and beeping headless.

## [0.1.0] — 2026-09-02 — SSIDs, a radio filter, and Wi-Fi foxhunting

### Added — network names

Wi-Fi rows now carry the SSID the device is announcing, and are titled by it
when they have no other name. A network name is the one field that lets a person
recognise their own hardware; a vendor prefix does not. Captured from beacons
and probe responses only — a probe *request* names the network a client is
looking for, which says nothing about the device sending it.

### Added — radio filter

Both radios / Bluetooth / Wi-Fi, shown only while the report filter is off,
where most of the list is access points and picking one radio actually matters.
A device heard on both counts as either.

### Added — foxhunting works over Wi-Fi

Two things the Bluetooth path got for free had to be built:

- The clicker cannot be driven from the promiscuous callback, which must never
  block on the hardware mutex. The sample is parked in a volatile and the 1 Hz
  task applies it.
- More importantly, the channel hopper meant hearing a given access point about
  one dwell in thirteen, so the clicker went quiet every time it moved on. While
  a Wi-Fi target is hunted the hopper parks on its channel. Detection of
  everything else pauses for the duration, which is the deal you accept when you
  lock onto one target.

### Changed — Ring is hidden on Wi-Fi-only devices

Ring is a GATT write to a Bluetooth characteristic. On a device only ever heard
over Wi-Fi there is nothing to connect to, so the button was a guaranteed
failure dressed up as an option.

### Fixed — a weak Lite-On hint was being counted as a camera

Reported from the field: two "Cameras" in a house with no ALPR. The Lite-On
vendor IE (50:6F:9A) scores 30 and deliberately sets *no* vendor category,
because that prefix is in countless consumer Wi-Fi chips. But the app derived a
row's band from `type || rule`, so a hit with no type fell through to the generic
bucket, which the Surveillance band includes. Confirmed on the bench: the two
devices carrying it here are a T-Mobile gateway (`TMOBILE-B430`) and a Sony
television (`DIRECT-ss-BRAVIA`).

Rows are now placed by `bandOf()`, which separates three states the old code
conflated: matched nothing, matched a rule the firmware refuses to attribute
("weak hint"), and matched a real vendor category. Only the last counts toward a
category band.

## [0.1.0] — 2026-09-02 — The band tabs were dead, and filter-off pushes were too big to arrive

### Fixed — clicking a band tab did nothing

The delegated click listener still matched `#lens-row .lens-tab` after the tabs
were rebuilt as `#bands .band` in the interface pass. Nothing threw and nothing
logged; the tabs simply did not respond, so the list was permanently stuck on
Everything. `node app/selftest.js` now cross-checks every id-anchored selector in
`app.js` against the ids in `index.html` before running anything else, and that
check fails on exactly this bug when reintroduced.

### Fixed — with the filter off, the app showed nothing at all

A filter-off push was ~4.4 KB, which is about 19 BLE notifications. Those are
unacknowledged and a push is reassembled from all of them, so losing any single
chunk truncates the JSON and the app discards that whole second — which looks
precisely like "the device is finding nothing".

Two changes bring it to ~1.4 KB and 6 notifications:

- Unmatched rows no longer carry `count`, `confidence` and `tier`. The app
  renders none of those for a device that matched nothing; they were tripling
  the size of the row that dominates a filter-off push.
- The per-push cap drops from 40 to 18 while the filter is off. Selection stays
  round-robin by staleness, never by RSSI, so nothing is starved — every device
  still comes round, over about two seconds instead of one.

The app now also counts pushes it failed to parse and says so on screen once
more than one in ten is being lost, rather than logging to a console nobody has
open on a phone. A render error in the foxhunt panel can no longer take the
device list down with it.

## [0.1.0] — 2026-09-02 — Everything the operator sets now survives a power cycle

The device is headless and unattended. Wired into a car it loses power every
time the engine stops; the foxhunt workflow is unplug from the laptop, move to a
USB battery, and walk away from the phone — also a power cycle. State that
evaporated on reboot could only be used while tethered to the thing you were
trying to leave behind.

### Fixed — the hunt target and the report filter are persisted

Both now live in NVS (`sweep-st`) and are restored by `startWatchersWatch()`.
The filter had been deliberately session-only on the grounds that it floods the
telemetry budget; that argument protected a budget that isn't being spent, since
`sendBleSerial()` returns early with no client subscribed. Verified across real
power cycles: set, reboot, still set; cleared, reboot, still cleared.

Already persisted and unaffected: signature rules, buzzer mute, BLE name and
random-address flag, hardware tier. `pendingRingMac` stays transient — it is a
one-shot action, not a setting.

### Fixed — a detection could be listed without ever sounding the buzzer

The alert call lived only on the "new target" path. A BLE device splits its data
between the advertisement and the scan response, and the name — the strongest
signal most rules have — frequently arrives only in the second one. The target
was therefore created unmatched by the first packet, and the packet that
actually identified it took the "already tracking" path, which never alerted:
drive past a camera, watch it appear in the list, hear nothing. Any rule pushed
after a device was first seen had the same problem.

`noteAlertForTarget()` now owns the decision and records it on the target, so a
device beeps once per appearance rather than once per advert. The flag clears
when the target goes stale and is pruned, so something you drive past twice
beeps twice. Applies to both radios and to the drone path.

### Added — the clicker goes quiet when the hunted target is out of earshot

The hunt stays armed across silence and across reboots; what stops is the noise.
Without this, a board restored from NVS — or one whose target has gone out of
range — would tick in your pocket at the "very far away" rate indefinitely,
which reads as "still tracking it" when it means nothing of the sort. Eight
seconds of silence stops the clicking; hearing the target again resumes it.

### Added — evidence that the headless path actually works

With nothing connected, the buzzer's only witness is a noise in another room,
and a serial print made seconds after boot is lost while the USB CDC port
re-enumerates — exactly when a freshly powered detector does its alerting.
`getAlertCount()` counts alerts since boot and `CMD:CFG` reports it, along with
the hunt target and filter state so a phone connecting to a board that has been
running headless adopts what it was already doing.

Bench result: rule pushed, power cycled, left alone, then read back — one alert
fired after the power cycle with no phone and no USB host listening.

## [0.1.0] — 2026-09-02 — Foxhunting, a location readout, and an interface that looks like an instrument

### Added — the filter switch and the foxhunt readout

The old Beacon Bandit's best trick is back: turn the filter off, find something
interesting, lock onto it, and physically walk it down.

- `{"scan_all":bool}` reports every tracked device instead of only signature
  matches. It lifts the *listing* gate only — `CONF_ALERT_MIN` still governs the
  buzzer, so the filter can be off in a crowded room without a single beep.
  Measured on the bench: 39-44 devices listed, none at or above the alert
  threshold. Not persisted; a reboot always comes back quiet.
- Hunt is offered on every row while the filter is off, and on trackers always.
- A locked target gets a full instrument rather than a row: the signal in
  numerals large enough to read at arm's length on a dash mount, a rolling trace
  of the last 40 samples, and a warmer / holding / colder call taken from the
  last few samples against the ones before them (3 dB, below which the reading
  is multipath noise rather than movement). The trace is signal strength only —
  there is no position in it — and it is dropped when the hunt stops.
- Both `hunt` and `scan_all` are echoed in the 1 Hz push and the app adopts what
  the device says. Neither survives a reboot, so after a reconnect the app must
  not keep believing it is hunting something the board has forgotten.

### Added — location status

Restores the GPS badge from the geospatial era, rebuilt around the one-shot fix
model that replaced `watchPosition`. Off, Locating, ±N m, or ±N m with "too
vague to pin" past 50 m; a refused permission reads differently from a cold lock
that timed out, because one is a settings problem and the other is worth
standing still outside for another few seconds. Confirming a pin on a fix that
vague now asks first — a pin is evidence of where a camera is, and one saved at
±200 m points at the wrong building.

### Changed — the interface

- The four tabs are now four channels of a receiver. Each carries its own count
  and a live meter of the strongest signal in that band, so a band going hot is
  visible while you are reading a different one. Colour is load-bearing and
  matches the buzzer's four words: red camera, orange body cam, blue drone,
  magenta tracker.
- Device, location and recording are three separate cells that fail
  independently, replacing the single status badge that only reported one of
  them. The old badge is hidden rather than deleted, since `updateConnectionUI`
  still writes to it.
- Monospace is now used for measured values only — addresses, dBm, coordinates,
  IDs — where columns have to align and 0 must not read as O. No webfont
  anywhere, deliberately: a detector is most needed where there is no network to
  fetch one.

### Fixed

- **A device that matched nothing was displayed as a match.** With the filter
  off, `categoryOf('')` fell through to the generic bucket, so every unnamed
  phone in range was titled "Match" behind a warning triangle — and counted in
  the Surveillance band, which read 5 cameras in a room containing one. No-match
  is now its own category: grey, tagged "no match", no confidence, no tier, and
  counted only under Everything. A detector that cries wolf in its own UI is the
  same failure as one that cries wolf with its buzzer.
- **The map showed "API KEY REQUIRED" across every tile.** CARTO's dark basemap
  is keyed now. Switched to plain OSM tiles darkened by a CSS filter on the tile
  pane, so markers and rings keep their real colours and nothing depends on a
  keyed service to draw a map.
- `showNextConsent()` threw on a missing modal element. It is called from inside
  the ingest loop, so that abandoned the rest of the telemetry batch and left
  the live list half-populated.
- Recording consent is no longer offered for unmatched devices. With the filter
  off it would otherwise ask permission to pin every phone on the street.

## [0.1.0] — 2026-09-02 — Put back what we missed, not what was wrong

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

## [0.1.0] — 2026-09-01 — Peel back to a simple beeper

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
