# SignalSweep

SignalSweep is a headless RF detector: an ESP32-S3 that scans Bluetooth LE and
Wi-Fi, matches what it hears against a signature list, and **beeps a different
pattern per category** so it tells you what is near without you looking at
anything. The phone app is optional — a live scope for what the device is
matching right now, not a logbook.

- 📷 **ALPR / camera** — two long beeps
- 🎥 **Body cam** — long-short-short
- 🛸 **Drone (Remote ID)** — rising trill
- 📍 **Tracker** — fast ticking

This monorepo holds both halves:

- `firmware/` — the ESP32-S3 firmware, built with PlatformIO.
- `app/` — the control app: plain hand-written HTML/CSS/JS wrapped in Vite +
  Capacitor for Android. (It is **not** React.)

The two talk over a BLE Nordic UART Service, or over a USB cable — which works
from a desktop browser and from an Android phone alike. There is no HTTP server
and no cloud.

---

## Quick start

You need one [Seeed Studio XIAO ESP32-S3](https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html)
(about $15) and a USB-C cable that carries data.

1. **Flash it** — open <https://b0z0dcl0wn.github.io/SignalSweep/> in desktop
   Chrome, Edge or Opera and press **Connect & flash**. No Python, no
   PlatformIO, no drivers.
2. **Open the app** — same site, `/app/`. Desktop Chrome or Android Chrome, over
   Bluetooth. Nothing to install.
3. **Or don't.** The device works alone. Give it USB power and it scans and
   beeps with nothing connected — that is the point of it.

### Or install everything from one command

If you have Python and `adb`, `install.py` downloads a published release and
puts it on your hardware — firmware, Android app, or both:

```
pip install esptool pyserial
python install.py                 # firmware + app, latest release
python install.py --apk-only      # just the Android app
python install.py --esp-only      # just the firmware
python install.py --list          # what is attached, changes nothing
python install.py --erase         # also reset the board to factory defaults
```

It never guesses what to touch: with more than one board or phone attached it
lists them and makes you pick, prints exactly what it is about to do, and waits
for you to type the target's name. Every download is checked against the sha256
GitHub publishes for it before anything is flashed.

**Without `--erase` your settings survive** — the buzzer mute, beep mask, hunt
target, BLE name and signature rules all live in NVS and a normal flash leaves
them alone. `--erase` wipes them back to defaults, and says so first.

The Android app is **sideload-only** — there is no Play Store listing. It is
signed with a stable release key, so updates install over the top and keep your
data. The first time you move from a self-built APK to a released one, Android
will refuse the upgrade because the signing keys differ; uninstall first, which
does destroy the encrypted pin store if you have one.

For the buzzer, the LED and the external antenna, see
[`firmware/WIRING.md`](firmware/WIRING.md). Building from source is documented
further down; you only need it if you want to change the firmware.

---

## What it deliberately does not do

This is a receiver. Offensive capability was removed on purpose and should not
grow back:

- **No jamming, no deauth, no packet injection.**
- **No advertisement spoofing.** The `ble_spoof` primitive was cut.
- **No arbitrary GATT writes.** The old build could write any service, any
  characteristic, any hex payload. That is gone. Ringing a tracker is one fixed
  Immediate Alert write (`0x1802` / `0x2A06` / `0x02`) with a MAC as its only
  parameter.
- **No cloud, no telemetry, no analytics, no account.**

### Threat model

The device is meant to be left somewhere and walked away from, so the failure
mode that matters is *it quietly recorded where you have been*.

- **No history, anywhere.** The app is a live scope: it shows what the device is
  matching right now and clears it on disconnect. There is no logbook, no
  breadcrumb trail, no map tile cache.
- **No passive location tracking.** Geolocation is a one-shot `getFix()` on a
  path you explicitly consent to — never a background `watchPosition`.
- **One persisted secret, opt in.** Location pins you confirm per device, stored
  only as AES-GCM ciphertext behind a PIN (Web Crypto, PBKDF2). Recording
  defaults to off. Detecting and beeping never ask for the PIN — it gates
  viewing and export only.
- **It can stop announcing itself.** Receive-only mode stops BLE advertising
  entirely, because a counter-surveillance tool that broadcasts `SignalSweep` to
  every scanner in range — including the hardware it is hunting — is doing the
  opposite of its job. It keeps scanning, matching and beeping while quiet.

### Legality

Receiving radio signals is legal in most jurisdictions. Transmitting generally
is not, and this device does not transmit — beyond a Bluetooth advertisement you
can switch off. Your local law is not the same as everyone else's; go and read
it.

---

## Using the device

Power it and walk away — everything below is optional.

### The BOOT button

| Press | What happens |
|---|---|
| **Tap** (under a second) | If the device is in receive-only, it advertises again for two minutes so the app can connect, then goes quiet on its own. Otherwise nothing. |
| **Hold 5 seconds** | Factory reset: wipes NVS and the signature file, then reboots. The red flash and warning tone each second are the "let go now" signal; releasing early aborts. |

### Receive-only

A detector that advertises "SignalSweep" announces itself to anyone else
running a scanner — including the hardware it is looking for. **Settings →
Emissions → Go quiet** stops it advertising; the radio then only listens. Over
Bluetooth that also drops your connection, because it is the link the command
travelled on.

It keeps scanning, keeps matching and keeps beeping — this is **not** the
buzzer mute, which is the separate `{"buzzer":false}` setting. Active scanning
stays on, because device names arrive in scan responses and the name-matching
rules need them.

The setting survives a power cycle, so a board left quiet comes back quiet. To
get back in: tap BOOT, or send `CMD:RXONLY:OFF` over USB, or hold BOOT for the
factory reset.

**Over a USB cable nothing is severed** — only the radio goes quiet, and the
same Settings control puts it back on the air. The drop-the-connection warning
applies to Bluetooth only.

### Driving it from the phone over USB

Plug the device into an Android phone with a USB-C cable and pick **Connect via
USB cable**. Android asks for permission once, then you get the full live view
and full control over the wire. This is how you use receive-only from a phone:
the radio is silent and the cable still works.

Android has no WebSerial — the API simply does not exist on the platform — so
this goes through the phone's own USB host stack
([usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) via
`@leeskies/capacitor-usb-serial`). The board enumerates as CDC/ACM. In a desktop
browser the same button uses WebSerial instead.

Two things worth knowing: the phone powers the board, so it is not charging
while connected; and opening the port resets the board, which is why the app
briefly shows the boot banner.

### Privacy

See [Threat model](#threat-model) above. Short version: no history, no passive
location tracking, and the only thing ever written to disk is location pins you
explicitly confirm, encrypted behind a PIN.

---

## 1. Firmware (`firmware/`)

Runs on a XIAO ESP32-S3. One codebase with one build environment per hardware
tier: `tier1` ships today (XIAO ESP32-S3 + external U.FL antenna, phone UI, USB
power), `tier2` and `tier3` are future hardware layers (screen/battery/second
radio, then GPS/buttons) built from the same source.

### Prerequisites

- [Visual Studio Code](https://code.visualstudio.com/)
- [PlatformIO extension](https://platformio.org/install/ide?install=vscode)

### Building and flashing

From the command line:

```bash
python flash.py --tier 1 --port COM3
```

That wraps `pio run -e tier1 -t upload`; `pio run -e tier1` alone just builds.
If `pio` is not on PATH, `python -m platformio` is the same tool. `--auto` is a
stub that falls through to tier1 — board auto-identification needs Tier 2
hardware that does not exist yet.

From the IDE: open the `firmware/` folder, let PlatformIO install the
dependencies from `platformio.ini`, connect the board over USB, then use
**PlatformIO: Upload**. **PlatformIO: Serial Monitor** shows the logs — note
that these boards are native USB CDC, so opening the port resets the board and
boot-time output is lost to re-enumeration.

### Serial commands

The same JSON commands the app sends over BLE also work over USB serial, one
per line, plus a few raw ones:

```
CMD:CFG            name, address mode, hunt target, filter, receive-only and
                   per-radio scan state, alert count
CMD:SIGS:RESET     restore the built-in signature rules
CMD:RXONLY:ON|OFF  enter / leave receive-only
CMD:BLE_SCAN:ON|OFF    pause / resume one radio; each replies with a fresh CMD:CFG
CMD:WIFI_SCAN:ON|OFF
```

A paused radio is reported as `ble_scan` / `wifi_scan` in `CMD:CFG`, and the
flag is set by these commands only — ringing a tracker pauses the BLE scan for
a moment internally and deliberately does not show up here. Neither survives a
power cycle: a board always boots with both radios scanning.

`CMD:CFG`'s `alerts` counter is how you prove the headless path works: push a
rule, power cycle, wait, then read the count back. Nonzero means it sounded
with nothing connected.

## 2. Control app (`app/`)

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or newer
- [Android Studio](https://developer.android.com/studio) for Android builds

### Setup and development

```bash
cd app
npm install
npm run dev        # browser preview, uses Web Bluetooth / Web Serial
node selftest.js   # category routing, pin crypto, selector-drift check
```

### Building for Android

```bash
npm run build
npx cap sync android
npx cap open android      # or: cd android && ./gradlew installDebug
```

---

## Signature rules — the most useful thing you can contribute

The detector is only as good as its signature list. Rules live in
`/data/signatures.json` on the device (LittleFS, auto-created with defaults on
first boot) and the defaults are compiled into
`firmware/src/mode_watchers_watch.cpp`. A rule matches on any of five fields:

| Field | Matches |
|---|---|
| `oui` | first three bytes of the MAC |
| `mfg_id` | Bluetooth SIG company ID |
| `device_name` | substring of the advertised name |
| `service_uuid` | substring of an advertised service UUID |
| `ssid` | Wi-Fi network name |

Each rule carries a **category**, which is what picks the buzzer pattern.

**A rule that fires on ordinary hardware is worse than no rule.** Two entries
were removed in v5 for exactly this: `raven` and `penguin` as name substrings
(ordinary words, enough on their own to sound the alarm on someone's Bluetooth
speaker), and four short service UUIDs. A company-ID rule for `0x01` labelled
Govee smart bulbs as surveillance hardware, because `0x0001` is Nokia's. OUI
prefixes with the locally-administered bit (`0x02`) set are rejected at load —
that is a randomized MAC, i.e. a phone, not a vendor.

So: send a PR with the rule, the category, and **how you confirmed it**. What
the hardware was, and how you know. Bump `SIG_SCHEMA_VERSION` when you change
the defaults, or already-deployed boards keep the old set for ever.

## Contributing

[CHANGELOG.md](CHANGELOG.md) is the design record — it documents the traps
that have already cost this project a working build, and is worth reading
before changing firmware. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules.

When you touch the BLE protocol, change **both** sides: the parser and JSON
producers in `firmware/src/`, and the command/consumer code in
`app/public/app.js`. `node app/selftest.js` must pass.

## License and credits

SignalSweep is **GPL-3.0-or-later** — see [LICENSE](LICENSE). Copyleft is
deliberate: a detector built to find surveillance hardware should not be
forkable into a closed product by the people who sell it.

`firmware/src/opendroneid.c`, `odid_wifi.c` and their headers are vendored
unmodified from
[opendroneid-core-c](https://github.com/opendroneid/opendroneid-core-c) and stay
**Apache-2.0** under their own copyright headers.

This project started from other people's work and says so in
**[CREDITS.md](CREDITS.md)** — Colonel Panic's OUI Spy, the Flock Safety OUI
research of OrdoOuroborous / @NitekryDPaul, and everyone else. Read it.
