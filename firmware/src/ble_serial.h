#ifndef BLE_SERIAL_H
#define BLE_SERIAL_H

#include <Arduino.h>

/**
 * @brief Initialize Nordic UART Service (NUS) using NimBLE
 */
void bleSerialInit();

/**
 * @brief Send string data over BLE TX characteristic (Notify) in MTU-sized chunks
 * @param data String data to send
 */
void sendBleSerial(const String& data);

/**
 * @brief Check if a BLE client is currently connected
 * @return true if connected, false otherwise
 */
bool isBleSerialConnected();

/**
 * @brief Process incoming command from BLE or Hardware Serial
 * @param rawCommand The JSON or raw text command
 */
void processIncomingCommand(const String& rawCommand);

// ---- BLE identity (name + address), persisted in NVS "ouispy-ble" ----------
// Both are read once at boot, before NimBLEDevice::init(), because neither can
// be changed on a running host without tearing the stack down. Setting either
// therefore stores it and reboots.

/** @brief Advertised BLE name. Default "SignalSweep". */
String getBleDeviceName();

/** @brief True if a fresh random static address is generated each boot. */
bool getRandomMacEnabled();

/**
 * @brief Persist a new BLE identity. Empty name restores the default. Does not
 * take effect until the reboot that requestReboot() schedules.
 */
void setBleIdentity(const String& name, bool randomMac);

/**
 * @brief Generate and install a random static BLE address for this boot. Call
 * after NimBLEDevice::init() and before advertising starts.
 */
void applyRandomMac();

// ---- Receive-only ---------------------------------------------------------
// Stop announcing this device: no advertising, no GATT link, scanning
// unchanged. Persisted alongside the identity in "ouispy-ble". NOT the buzzer
// mute — that is {"buzzer":false} and is unaffected.

/** @brief True while the device is not advertising itself. */
bool getRxOnly();

/**
 * @brief Re-advertise for two minutes so a phone can get back in, then go
 * quiet again if nobody connected. Called from the short-BOOT-press branch in
 * loop(). No-op unless the device is in receive-only.
 */
void openAdvertisingWindow();

/** @brief Closes an expired advertising window. Call from loop(). */
void bleSerialTick();

/** @brief Current identity + tier as JSON, for the app's settings page. */
String getBleConfigJson();

/** @brief Ask main's loop() to reboot shortly (lets the BLE reply flush). */
void requestReboot();

/** @brief True once requestReboot() has been called and the delay has passed. */
bool rebootDue();

#endif // BLE_SERIAL_H
