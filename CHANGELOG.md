# Changelog

All notable changes to SignalSweep are recorded here.

## [Unreleased]

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
the signature `89 50 4E 47 0A 1A 0A` -- missing the `` that PNG puts there
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
