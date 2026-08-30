#ifndef BLE_SERIAL_H
#define BLE_SERIAL_H

#include <Arduino.h>

/**
 * @brief Initialize Nordic UART Service (NUS) using NimBLE
 */
void bleSerialInit();

/**
 * @brief Restore Nordic UART Service (NUS) advertisement payload
 */
void restoreBleSerialAdvertising();

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

#endif // BLE_SERIAL_H
