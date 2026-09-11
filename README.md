# SignalSweep

A $15 ESP32-S3 that listens for the gear that's watching you. It sweeps
Bluetooth LE and Wi-Fi nonstop, checks everything it hears against a list of
known surveillance hardware, and **tells you what it found by ear**. Every
category has its own beep, so it works with no screen at all.

- 📷 **ALPR / camera**: two long beeps
- 🎥 **Body cam**: long, short, short
- 🛸 **Drone (Remote ID)**: rising trill
- 📍 **Tracker (AirTag/Tile)**: fast ticking

The phone app is optional. It shows what's here right now, then forgets it.

| `live` | `hunt <mac>` | `map` |
|---|---|---|
| ![Live scope](docs/img/scope.png) | ![Foxhunt](docs/img/foxhunt.png) | ![Drone on the map](docs/img/map-drone.png) |
| Live matches, strongest first. Cleared when you disconnect. | One target. The beeps speed up as you close in. Walk, don't watch the screen. | Full ASTM F3411 decode: aircraft position and operator position. |

*Bench rig: a second $15 board faking a drone, a Flock camera and an AirTag, so
there's a known signal to check against.*

---

## What it does

- **Runs headless.** Throw it in a bag with a battery or wire it into the car.
  It scans and beeps with nothing connected.
- **Survives the plug-pull.** Mute, muted categories, hunt target, filter, BLE
  name and signature rules all come back after a power cycle. Yanking the cable
  is how you're supposed to use it.
- **Keeps its mouth shut.** Receive-only kills its Bluetooth advertising, so it
  isn't announcing `SignalSweep` to every scanner in range, including the gear
  it's hunting. It keeps listening, matching and beeping.
- **Mutes what you don't care about.** Every AirTag on the bus trips the tracker
  beep. That's the detector working, and you still don't need to hear it. Mute
  that one category, or tap Cameras, Trackers or Drones to hear only that. The
  app still lists everything the buzzer skips.
- **Lights on your terms.** Each category has its own LED animation. Run the bar
  off, one LED, dim or full, so a parked car doesn't glow like a beacon.
- **Foxhunts.** Lock one MAC and walk it down by ear. Found an AirTag you didn't
  put there? Make it ring.
- **Reads drone Remote ID in full** (ASTM F3411 / OpenDroneID) over BLE, Wi-Fi
  beacons and Wi-Fi NAN: ID, position, altitude, heading, and where the operator
  is standing. Often before you can hear the props.
- **Names what it hears.** Vendor lookup runs offline against the IEEE and
  Bluetooth SIG tables. No MAC ever leaves your phone. Wi-Fi rows tell access
  points from clients.
- **Runs your rules.** Signatures are a JSON file on the device, editable from
  the app: OUI, company ID, device name, service UUID or SSID. No recompile.
- **Bluetooth or USB-C.** Plug it into an Android phone and the phone powers it,
  reads it over the cable, and the Bluetooth radio can go dark.

## What it won't do

> The only winning move is not to transmit.

No jamming. No deauth. No packet injection. No advert spoofing. No arbitrary
GATT writes. It's a receiver. Ringing a tracker is one fixed Immediate Alert
write, and its only parameter is a MAC.

No cloud, no telemetry, no accounts, no logs. What's in range shows up, and it's
wiped when you disconnect. The one thing it can keep is a location pin you say
yes to, one device at a time, stored as AES-GCM ciphertext behind a PIN. Pinning
is off by default, and detection never asks for the PIN.

Listening to radio is legal in most places. Transmitting usually isn't, and this
doesn't, apart from a Bluetooth advert you can switch off. Your local law isn't
everyone's. Go and read it.

---

## Getting started

You need a [Seeed Studio XIAO ESP32-S3](https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html)
(~$15) and a USB-C cable. That's the whole shopping list.

**Browser, zero install.** Open
[b0z0dcl0wn.github.io/SignalSweep](https://b0z0dcl0wn.github.io/SignalSweep/) in
Chrome or Edge, plug the board in, hit **Connect & flash**. The app lives at
`/app/` on the same site and talks to the board over Bluetooth.

**Script: firmware plus the Android APK.**

```bash
pip install esptool pyserial
python install.py
```

Flashes the board and sideloads the APK over `adb`. It lists what's plugged in
and makes you type the target's name back before it writes a byte.
`install.py --help` has `--apk-only`, `--esp-only` and `--erase`.

## Hardware and controls

The bare board works. Add a **passive buzzer** and a **WS2812 LED bar** and it
gets loud and bright. Parts and wiring are in the
**[Wiring Guide](firmware/WIRING.md)**.

| BOOT button | What it does |
|---|---|
| **Quick tap** | Gone quiet? Advertises for two minutes so the app can connect, then goes dark again. |
| **Hold 5 s** | Factory reset: settings and signatures wiped, then a reboot. Let go early to abort. |

## Contributing

SignalSweep is only as good as its signature list. Spotted a tracker, body cam
or ALPR it misses? Send a PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

The deep end (threat model, serial protocol, building from source, and why
everything is the way it is) lives in
**[docs/README-full.md](docs/README-full.md)** and [CHANGELOG.md](CHANGELOG.md).

## Credits

- **[Colonel Panic](https://colonelpanic.tech)**: the
  [OUI Spy Unified Blue](https://github.com/colonelpanichacks/oui-spy-unified-blue)
  concept this hardware approach came from.
- **[OrdoOuroborous / @NitekryDPaul](https://github.com/nitekry)**: the Flock
  Safety OUI research the camera detection runs on.

Everyone else is in [CREDITS.md](CREDITS.md).

GPL-3.0-or-later. See [LICENSE](LICENSE). Some vendored components are Apache-2.0.

*Hack the planet.*
