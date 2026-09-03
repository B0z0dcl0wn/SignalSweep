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

The two talk over a BLE Nordic UART Service, with USB serial as a mirror. There
is no HTTP server and no cloud.

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
Emissions → Go quiet** stops it advertising and drops the connection; the radio
then only listens.

It keeps scanning, keeps matching and keeps beeping — this is **not** the
buzzer mute, which is the separate `{"buzzer":false}` setting. Active scanning
stays on, because device names arrive in scan responses and the name-matching
rules need them.

The setting survives a power cycle, so a board left quiet comes back quiet. To
get back in: tap BOOT, or send `CMD:RXONLY:OFF` over USB, or hold BOOT for the
factory reset.

### Privacy

The app keeps no history of what was detected or where you went. The only thing
stored is location pins you explicitly confirm, one device at a time, encrypted
behind a PIN. Detecting and beeping never ask for the PIN — it gates only
viewing and export.

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
If `pio` is not on PATH, `python -m platformio` is the same tool. `--auto` reads
the tier back from a running board.

From the IDE: open the `firmware/` folder, let PlatformIO install the
dependencies from `platformio.ini`, connect the board over USB, then use
**PlatformIO: Upload**. **PlatformIO: Serial Monitor** shows the logs — note
that these boards are native USB CDC, so opening the port resets the board and
boot-time output is lost to re-enumeration.

### Serial commands

The same JSON commands the app sends over BLE also work over USB serial, one
per line, plus a few raw ones:

```
CMD:CFG            name, address mode, hunt target, filter and receive-only state, alert count
CMD:SIGS:RESET     restore the built-in signature rules
CMD:RXONLY:ON|OFF  enter / leave receive-only
CMD:BLE_SCAN:ON|OFF
CMD:WIFI_SCAN:ON|OFF
```

`CMD:CFG`'s `alerts` counter is how you prove the headless path works: push a
rule, power cycle, wait, then read the count back. Nonzero means it sounded
with nothing connected.

---

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

## Contributing

`CLAUDE.md` is the design record — it documents the traps that have already
cost this project a working build, and is worth reading before changing
firmware. When you touch the BLE protocol, change **both** sides: the parser
and JSON producers in `firmware/src/`, and the command/consumer code in
`app/public/app.js`.
