# Credits

SignalSweep stands on other people's work. This file names it.

## Prior art

**[colonelpanichacks](https://github.com/colonelpanichacks)** — *[OUI Spy
Unified Blue](https://github.com/colonelpanichacks/oui-spy-unified-blue)*

OUI Spy got there first with a headless XIAO ESP32-S3 detector you flash from
a browser and hunt with by ear. It was an inspiration for SignalSweep.

Also from colonelpanichacks, and worth your time:
[ouispy-foxhunter](https://github.com/colonelpanichacks/ouispy-foxhunter),
[flock-you](https://github.com/colonelpanichacks/flock-you).

## Surveillance hardware research

**OrdoOuroborous / [@NitekryDPaul](https://github.com/nitekry)** — the Flock
Safety OUI research.

The Flock MAC prefixes in `firmware/src/mode_watchers_watch.cpp` are his
promiscuous-mode set. Compiling that list meant finding the cameras, capturing
them, and confirming the prefixes — none of which is work you can shortcut.
Everything this device knows about Flock hardware, it knows because of him.

**DeFlockJoplin** ([DeflockJoplin/flock-you](https://github.com/DeflockJoplin/flock-you),
[deflockjoplin.today](https://deflockjoplin.today)) — the **wildcard-probe-request
signature** and the **Lite-On IE fingerprint**. After Flock's management AP and
BLE both went dark (Dec 2025 / spring 2026), a camera that still has Wi-Fi on
spams zero-length-SSID probe requests. Pairing that behaviour with the OUI is how
this detector lists one; the exact Lite-On vendor IE payload
(`50:6f:9a:16:03:01:03`) tightens it further. Drive-tested in Joplin at 11 of 12
cameras caught with 2 false positives. Reached us via colonelpanichacks/flock-you.
Here it lists rather than beeps, because ordinary Lite-On modules send the same
probes, and most deployed cameras keep Wi-Fi off on LTE and transmit nothing.

**Flock camera firmware dump** (published 2026-09, collected in
[colonelpanichacks/flock-you](https://github.com/colonelpanichacks/flock-you)
issue #15, MIT) — the solar battery's GATT service UUIDs (auth
`e8ccbb38-…`, safety `20c944c1-…`) and, read alongside it, the finding that a
healthy camera advertises nothing at all. Values only; SquachWatch-CYD pointed us
back to them.

**Will Greenberg ([@wgreenberg](https://github.com/wgreenberg))** — his
[flock-you](https://github.com/wgreenberg/flock-you) fork advanced the Flock
detection heuristics and the structured approach to managing detection
patterns, which is the shape the signature rules here took.

**[DeFlock](https://deflock.me)** — the community mapping ALPR deployments in
the open. This detector finds cameras; DeFlock is where knowing about them
turns into something useful. Verify with your own eyes before you submit.

- **[SquachWatch-CYD](https://github.com/skizzophrenic/SquachWatch-CYD)** (GPL-3.0) by skizzophrenic —
  the idea of grading each signature by who the IEEE says owns it, the Axon body-cam pairing SSIDs,
  the smart-glasses company IDs, the Flipper Zero, Pineapple and ESP-deauther signatures, the per-device ignore list, and the crash breadcrumb. No code taken; every value re-checked against the IEEE and
  Bluetooth SIG registries, which is how we also caught two of their Axon OUIs (one unregistered,
  one a module maker) and three of our own mislabelled "Sierra Wireless" prefixes.
- **[RF Sentinel](https://github.com/CIS-C0/RFSentinel)** (GPL-3.0) by CIS-C0 — the TASER
  company-ID squatter check (IDO / VeryFit smartwatches), ported into `firmware/src/axon_checks.h`
  with its unit-test case, the Raven `3101`/`3102` UUIDs, and the French drone beacon layout.
- **[OVERWATCH](https://github.com/KaraZajac/OVERWATCH)** (BSD-3-Clause) by Kara Zajac — the Fusus
  blocks, the Axon `fe6c` Signal trigger layout, AxonCadabra's replayed serial, and the attack-gear
  default APs, BSSIDs and nyanBOX UUID in v25. Values only.
- **[AirGuard](https://github.com/seemoo-lab/AirGuard)** (Apache-2.0) by SEEMOO, TU Darmstadt — the
  Find My status-byte layout that tells an AirTag from AirPods or an iPhone. Facts only.
- **[Fieldwatch](https://github.com/OffGridPete/Fieldwatch)** (MIT) and
  **[Kismet](https://github.com/kismetwireless/kismet)** — the DJI DroneID vendor IE `26:37:12`. Values only.
- **[Porkchop-cyd-Port](https://github.com/Xombi3/Porkchop-cyd-Port)** — the GhostLink / WarDriveGo
  bridge UUID, read from its source. Value only.
- **[le_detector_c5](https://github.com/datafx/le_detector_c5)** (GPL-3.0) by datafx — the road test
  that showed PRO-VISION `9c:83:bf` firing on school buses. Values only.
- **[All Cameras Are Beacons](https://github.com/soyboitech/beacons)** (Apache-2.0) by Spencer Sams —
  the field captures of Axon's `METROPOLISDEVICE` advert tag. Values only.
- **[M5PORKCHOP](https://github.com/0ct0sec/M5PORKCHOP)** (MIT) by 0ct0sec — the BACON vendor IE
  (`50:52:4B`, type `0x01`), read from its source. Values only.
- **[cyd-scanner](https://github.com/negativeaffirmations/cyd-scanner)** (GPL-3.0) — the field
  capture of a router deauthing its own client, now a regression test.

## Tile

**[lesleyxyz/node-tile](https://github.com/lesleyxyz/node-tile)**: reverse-engineered
research into the Tile BLE protocol. It is where we learned that a Tile that was
never activated advertises `0xFEEC`, and that ringing a Tile needs the owner's
account authkey. We used the facts only; none of its code is in this tree.

## Apple Continuity / Find My

**[furiousMAC/continuity](https://github.com/furiousMAC/continuity)** — the
reverse-engineered wire format for Apple's Continuity BLE protocol, and the
companion paper *Handoff All Your Privacy* (Martin, Alpuche, Bodeman, Brown,
Fenske, Foppe, Mayberry, Rye, Sipes, Teplov).

Their documentation is why a row can say "Apple: iPhone/iPad/Mac (active,
screen on)" instead of an anonymous random MAC: the message-type bytes, the
Nearby Info status/activity nibbles and the data flags are all theirs. It is
also why our tracker category means something — Find My sends a 2-byte status
ping from *every* Apple device and a 25-byte payload only from something
separated from its owner, and until we read their work we matched both.

Their dissector is GPL-2.0-only, which is not compatible with this project's
GPL-3.0-or-later, so **no code was taken**. We implemented our own decoder from
the documented field meanings and verified every value against our own captures.

## Drone Remote ID

**[opendroneid-core-c](https://github.com/opendroneid/opendroneid-core-c)** —
Apache-2.0, vendored unmodified as `firmware/src/opendroneid.c`,
`odid_wifi.c` and their headers.

Copyright (C) 2019 Intel Corporation (maintainer: Gabriel Cox); (C) 2020 Simon
Wunderlich, Marek Sobe; (C) 2020 Doodle Labs. The full ASTM F3411 decode is
theirs — we call it, we did not write it.

## Pwnagotchi gzip decode (ESP32-C5)

**[miniz](https://github.com/richgel999/miniz)** — MIT, by Rich Geldreich and
contributors. The S3 gets `tinfl_decompress` for free from its ROM
(`esp32s3.rom.ld`); the ESP32-C5's IDF-5.x ROM dropped miniz, so
`firmware/src/vendor/miniz_tinfl.{h,c}` vendors just the `tinfl_*` inflate
half (no deflate/compress, no zip-archive code) so the C5 can gunzip a real
pwnagotchi/pwngrid advertisement the same way the S3 already does. License
header kept verbatim in both files; gated to build only under
`CONFIG_IDF_TARGET_ESP32C5` so the S3 keeps using its ROM copy unchanged.

## Libraries

| Library | Author |
|---|---|
| [NimBLE-Arduino](https://github.com/h2zero/NimBLE-Arduino) | h2zero |
| [ArduinoJson](https://arduinojson.org/) | Benoit Blanchon |
| [Adafruit NeoPixel](https://github.com/adafruit/Adafruit_NeoPixel) | Adafruit |
| [TinyGPSPlus](https://github.com/mikalhart/TinyGPSPlus) | Mikal Hart |
| [Leaflet](https://leafletjs.com/) | Volodymyr Agafonkin and contributors |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | OSM contributors (map tiles) |
| [Capacitor](https://capacitorjs.com/) | Ionic |
| [usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) | mik3y |
| [@leeskies/capacitor-usb-serial](https://github.com/leeskies/capacitor-usb-serial) | leeskies |
| [ESP Web Tools](https://github.com/esphome/esp-web-tools) | Nabu Casa |
| [PlatformIO](https://platformio.org/) | PlatformIO Labs |
| [Share Tech Mono](https://fonts.google.com/specimen/Share+Tech+Mono) (font, SIL OFL 1.1, `share-tech-mono-OFL.txt`) | Carrois Type Design, Ralph du Carrois |

## If we missed you

Open an issue. Being credited correctly matters more to us than being right
about who we credited.
