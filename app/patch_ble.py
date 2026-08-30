import re

def patch():
    with open('index.html', 'r', encoding='utf-8') as f:
        content = f.read()

    # Add <script type="module" src="/src/main.js"></script> if not there
    if '<script type="module" src="/src/main.js"></script>' not in content:
        content = content.replace('</head>', '    <script type="module" src="/src/main.js"></script>\n</head>')

    # Update connectWebBluetooth to branch for Capacitor
    replacement_connect = """async function connectWebBluetooth() {
            if (window.Capacitor && window.Capacitor.isNativePlatform()) {
                await connectNativeBluetooth();
                return;
            }
"""
    content = content.replace('async function connectWebBluetooth() {\n', replacement_connect)

    # Insert connectNativeBluetooth function
    native_bluetooth_fn = """
        async function connectNativeBluetooth() {
            const pulseDot = document.getElementById('pulseDot');
            const connStatusText = document.getElementById('connStatusText');
            pulseDot.className = 'pulse-dot connecting';
            connStatusText.textContent = 'CONNECTING NATIVE BLE...';

            try {
                await window.BleClient.initialize({ androidNeverForLocation: true });
                const device = await window.BleClient.requestDevice({
                    services: [NUS_SERVICE_UUID],
                    optionalServices: [NUS_SERVICE_UUID]
                });
                
                await window.BleClient.connect(device.deviceId, (deviceId) => {
                    onDeviceDisconnected();
                });
                
                bleDevice = device;
                
                await window.BleClient.startNotifications(
                    device.deviceId,
                    NUS_SERVICE_UUID,
                    NUS_TX_UUID,
                    (value) => {
                        const decoder = new TextDecoder('utf-8');
                        const chunk = decoder.decode(value.buffer);
                        processIncomingChunk(chunk);
                    }
                );
                
                updateConnectionUI(true, 'BLE');
                sendCommand({ get: 'status' });
            } catch (err) {
                console.error('Native BLE Connect Failed:', err);
                updateConnectionUI(false);
                showToast(`Native BLE Connect Failed: ${err.message || err}`, '✕');
            }
        }
"""
    if 'async function connectNativeBluetooth' not in content:
        content = content.replace('async function connectWebBluetooth', native_bluetooth_fn + '\n        async function connectWebBluetooth')

    # Modify sendCommand
    send_cmd_replacement = """if (connectionType === 'BLE') {
                try {
                    const encoder = new TextEncoder();
                    const data = encoder.encode(jsonStr);
                    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
                        await window.BleClient.write(bleDevice.deviceId, NUS_SERVICE_UUID, NUS_RX_UUID, new DataView(data.buffer));
                    } else if (rxCharacteristic) {
                        if (rxCharacteristic.writeValueWithoutResponse) {
                            await rxCharacteristic.writeValueWithoutResponse(data);
                        } else {
                            await rxCharacteristic.writeValueWithResponse(data);
                        }
                    }
                    return true;
                } catch (err) {"""
    
    # regex sub to replace the existing connectionType === 'BLE' block in sendCommand
    pattern = r"if \(connectionType === 'BLE' && rxCharacteristic\) \{[\s\S]*?try \{[\s\S]*?const encoder = new TextEncoder\(\);[\s\S]*?const data = encoder\.encode\(jsonStr\);[\s\S]*?if \(rxCharacteristic\.writeValueWithoutResponse\) \{[\s\S]*?await rxCharacteristic\.writeValueWithoutResponse\(data\);[\s\S]*?\} else \{[\s\S]*?await rxCharacteristic\.writeValueWithResponse\(data\);[\s\S]*?\}[\s\S]*?return true;[\s\S]*?\} catch \(err\) \{"
    
    content = re.sub(pattern, send_cmd_replacement, content)

    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(content)

if __name__ == '__main__':
    patch()
