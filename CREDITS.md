# Credits

SignalSweep stands on other people's work. This file names it.

## The project this one came from

**[colonelpanichacks](https://github.com/colonelpanichacks)** — *[OUI Spy
Unified Blue](https://github.com/colonelpanichacks/oui-spy-unified-blue)*

SignalSweep exists because OUI Spy showed what a XIAO ESP32-S3 could be: a
headless detector that tells you what is near by the noise it makes, a
Geiger-counter foxhunt for walking a beacon down by ear, and a firmware you
flash from a browser instead of a toolchain. Those three ideas are the spine of
this project.

The code here is an independent implementation — we measured it, and the
firmware shares roughly seven lines with OUI Spy's detector, all of them
framework boilerplate like `esp_wifi_set_promiscuous(true)`. That is not a
claim of originality. The hard part of a detector is knowing what is worth
detecting and what a false positive costs you, and that understanding came from
reading their work.

Also theirs, and worth your time:
[ouispy-foxhunter](https://github.com/colonelpanichacks/ouispy-foxhunter),
[flock-you](https://github.com/colonelpanichacks/flock-you).

## Surveillance hardware research

**OrdoOuroborous / [@NitekryDPaul](https://github.com/nitekry)** — the Flock
Safety OUI research.

The 36 MAC prefixes in `firmware/src/mode_watchers_watch.cpp` are his
promiscuous-mode set. Compiling that list meant finding the cameras, capturing
them, and confirming the prefixes — none of which is work you can shortcut.
Everything this device knows about Flock hardware, it knows because of him.

**Will Greenberg ([@wgreenberg](https://github.com/wgreenberg))** — his
[flock-you](https://github.com/wgreenberg/flock-you) fork advanced the Flock
detection heuristics and the structured approach to managing detection
patterns, which is the shape the signature rules here took.

**[DeFlock](https://deflock.me)** — the community mapping ALPR deployments in
the open. This detector finds cameras; DeFlock is where knowing about them
turns into something useful. Verify with your own eyes before you submit.

## Drone Remote ID

**[opendroneid-core-c](https://github.com/opendroneid/opendroneid-core-c)** —
Apache-2.0, vendored unmodified as `firmware/src/opendroneid.c`,
`odid_wifi.c` and their headers.

Copyright (C) 2019 Intel Corporation (maintainer: Gabriel Cox); (C) 2020 Simon
Wunderlich, Marek Sobe; (C) 2020 Doodle Labs. The full ASTM F3411 decode is
theirs — we call it, we did not write it.

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

## If we missed you

Open an issue. Being credited correctly matters more to us than being right
about who we credited.
