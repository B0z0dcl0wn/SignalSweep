# SignalSweep

SignalSweep is a unified project containing both the ESP32 firmware and the accompanying mobile/web control application.

## Directory Structure

This monorepo is divided into two main components:

- irmware/ : The ESP32-S3 firmware code, built using PlatformIO.
- pp/      : The frontend user interface and control app, built using React, Vite, and Capacitor.

---

## 1. Firmware (irmware/)

The firmware is designed to run on a XIAO ESP32-S3 board. It handles hardware interfacing, Bluetooth Low Energy (BLE) communication, and GPS data (if applicable).

### Prerequisites
- [Visual Studio Code](https://code.visualstudio.com/)
- [PlatformIO Extension](https://platformio.org/install/ide?install=vscode)

### Building and Flashing
1. Open the irmware/ folder in Visual Studio Code (or open the root folder and navigate to the firmware workspace if configured).
2. Wait for PlatformIO to initialize and install the required dependencies (as defined in platformio.ini).
3. Connect your XIAO ESP32-S3 to your computer via USB.
4. Click the **PlatformIO: Upload** button (right arrow icon in the bottom status bar) to compile and flash the firmware to the device.
5. Use the **PlatformIO: Serial Monitor** (plug icon) to view debug logs.

**From the command line:** the firmware has one build environment per hardware tier. Flash the current cheap/off-the-shelf build with `python flash.py --tier 1 --port COM3` (Tier 1 uses a XIAO ESP32-S3 with an external U.FL antenna). `--tier 2/3` target future hardware layers (screen/battery/second-radio, then GPS/buttons) from the same codebase.

---

## 2. Control App (pp/)

The app provides the graphical interface to control the SignalSweep device over Bluetooth Low Energy (BLE). It uses Capacitor to support mobile builds (Android) alongside a standard web preview.

### Prerequisites
- [Node.js](https://nodejs.org/) (v16 or newer recommended)
- [Android Studio](https://developer.android.com/studio) (if building the Android app)

### Setup & Development
1. Open a terminal and navigate to the pp/ directory:
   `ash
   cd app
   `
2. Install the dependencies:
   `ash
   npm install
   `
3. Run the development server (runs locally in your browser):
   `ash
   npm run dev
   `

### Building for Android
To build the app for an Android device:
1. Build the web assets:
   `ash
   npm run build
   `
2. Sync the assets to the Capacitor Android project:
   `ash
   npx cap sync android
   `
3. Open the project in Android Studio to build the APK or run it on a connected device/emulator:
   `ash
   npx cap open android
   `

## Contributing
When making changes, please ensure that you are working in the appropriate subdirectory (pp/ or irmware/) and testing changes before committing.

