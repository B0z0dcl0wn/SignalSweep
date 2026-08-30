import asyncio
from bleak import BleakScanner
import time
from datetime import datetime

TARGET_PREFIXES = ["SignalSweep", "ESP32"]

async def main():
    print("==================================================")
    print("SignalSweep Liveness Monitor")
    print("==================================================")
    print("This script will continuously scan for the SignalSweep")
    print("BLE advertisement to verify the ESP32 has not frozen.")
    print("Press Ctrl+C to stop.")
    print("==================================================\n")

    consecutive_misses = 0

    while True:
        try:
            print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Scanning for 5 seconds...")
            devices = await BleakScanner.discover(timeout=5.0)
            
            found = False
            for d in devices:
                if d.name and any(d.name.startswith(prefix) for prefix in TARGET_PREFIXES):
                    print(f"  [OK] Device Found! Name: {d.name}, MAC: {d.address}, RSSI: {d.rssi} dBm")
                    found = True
                    consecutive_misses = 0
                    break
            
            if not found:
                consecutive_misses += 1
                print(f"  [WARNING] Device not found in this scan. (Consecutive misses: {consecutive_misses})")
                
                if consecutive_misses >= 3:
                    print("  [ERROR] Device has not been seen for 3 consecutive scans. It may be frozen or out of range!")
            
            print("Waiting 10 seconds before next scan...\n")
            await asyncio.sleep(10)
            
        except KeyboardInterrupt:
            print("\nStopping monitor...")
            break
        except Exception as e:
            print(f"  [ERROR] Scan failed: {e}")
            await asyncio.sleep(5)

if __name__ == "__main__":
    asyncio.run(main())
