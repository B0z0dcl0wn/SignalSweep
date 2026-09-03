# SignalSweep Project Context

Welcome to the SignalSweep project! 

## Project Overview
This repository is a monorepo containing the software for the SignalSweep device. It is split into two distinct parts:
- **`firmware/`**: Contains the C++/Arduino firmware for the XIAO ESP32-S3, managed via PlatformIO. It handles BLE communication, hardware interfacing, and GPS.
- **`app/`**: Contains the Vite + Capacitor frontend application. The UI is a single hand-written `index.html` (plain HTML/CSS/JS — not React); `src/main.js` is a thin shim that exposes the Capacitor/Leaflet plugins on `window`. Capacitor compiles it to an Android app that talks to the device over BLE.

## Agent Guidelines

When working in this repository, please adhere to the following rules:

### General
1. **Directory Context**: Always pay attention to whether a task requires changes in `firmware/` or `app/`. Avoid bleeding logic between them unless updating the BLE communication protocol in both places.
2. **Readability**: Prioritize clean, well-documented code. Add comments to complex logic, especially for hardware interactions and BLE characteristics.
3. **Read `CLAUDE.md` first.** It is the design record for this repository: what the device is for, and the specific traps that have already cost a working build (the advertising payload API, the LittleFS mount, the telemetry budget, receive-only's disconnect gate). It is not Claude-specific.

### Firmware (`firmware/`)
1. Use modern C++ standards supported by the PlatformIO ESP32 toolchain.
2. Rely on the existing libraries defined in `platformio.ini` (e.g., NimBLE, ArduinoJson, TinyGPSPlus).
3. Be mindful of memory constraints (PSRAM is available on this board, use it when necessary).

### App (`app/`)
1. The UI lives in `index.html` as plain HTML/CSS/JS (no framework). Native features are reached through the `@capacitor/*` and `@capacitor-community/*` plugins hung on `window` by `src/main.js` — do not use generic web APIs for native geolocation/BLE.
2. Keep the UI responsive and mobile-friendly.

---
*Note to the user: You can edit this file at any time to teach me new rules, preferred patterns, or to add architectural notes about the project!*
