# SignalSweep Project Context

Welcome to the SignalSweep project! 

## Project Overview
This repository is a monorepo containing the software for the SignalSweep device. It is split into two distinct parts:
- **`firmware/`**: Contains the C++/Arduino firmware for the XIAO ESP32-S3, managed via PlatformIO. It handles BLE communication, hardware interfacing, and GPS.
- **`app/`**: Contains the React + Vite frontend application. It uses Capacitor to compile to an Android mobile app, communicating with the device over BLE.

## Agent Guidelines

When working in this repository, please adhere to the following rules:

### General
1. **Directory Context**: Always pay attention to whether a task requires changes in `firmware/` or `app/`. Avoid bleeding logic between them unless updating the BLE communication protocol in both places.
2. **Readability**: Prioritize clean, well-documented code. Add comments to complex logic, especially for hardware interactions and BLE characteristics.

### Firmware (`firmware/`)
1. Use modern C++ standards supported by the PlatformIO ESP32 toolchain.
2. Rely on the existing libraries defined in `platformio.ini` (e.g., NimBLE, ArduinoJson, TinyGPSPlus).
3. Be mindful of memory constraints (PSRAM is available on this board, use it when necessary).

### App (`app/`)
1. Use functional React components and Hooks.
2. Do not use generic web APIs for native device features—always rely on the `@capacitor/*` and `@capacitor-community/*` plugins listed in `package.json` (like geolocation and BLE).
3. Ensure UI components are responsive and mobile-friendly.

---
*Note to the user: You can edit this file at any time to teach me new rules, preferred patterns, or to add architectural notes about the project!*
