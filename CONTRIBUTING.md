# Contributing

Short version: read `CLAUDE.md` first, keep both sides of the BLE protocol in
sync, and make `node app/selftest.js` pass.

## Read the design record first

`CLAUDE.md` is not boilerplate. It documents the specific traps that have
already cost this project a working build — the advertising payload API that
silently stops the app connecting, the missing LittleFS mount that turns every
signature rule into dead code without an error, the telemetry budget where an
oversized push is not slow but *lost*. Skimming it will save you a day.

## The rules that actually matter

**Change both sides of the protocol.** The firmware parser
(`firmware/src/ble_serial.cpp`) and JSON producers (`getWatchersTargetsJson`)
and the app's command/consumer code (`app/public/app.js`) are one contract. A
field the device sends that the app ignores is state the app then guesses at.

**Operator state must survive a power cycle.** The device is headless and
unattended: wired into a car it loses power whenever the engine stops, and the
foxhunt workflow is *unplug, move to a battery, walk away*. Settings that
evaporate on reboot can only be used while tethered to the thing you were trying
to leave behind. Before adding anything operator-facing, decide where it
persists.

**Do not add offensive capability.** No jamming, no deauth, no injection, no
advertisement spoofing, no arbitrary GATT writes. These were removed
deliberately and the reasoning is in `CLAUDE.md` and the changelog. A PR that
adds one will be declined regardless of how well it is written.

**Do not reintroduce a passive trail.** No `watchPosition`, no history, no tile
cache, no sighting store. The absence of these is the product.

**A false positive is a real bug.** A detector that cries wolf gets ignored, and
an ignored detector is worse than none. See the signature-rule section in the
README before adding a rule.

## Before you open a PR

## Reporting a detection

Found hardware the detector misses, or a rule that fires on something innocent?
Open an issue with the vendor, the MAC prefix or name, and how you confirmed it.
Evidence beats a guess — this list is the difference between a useful tool and
an alarm that everyone learns to ignore.
