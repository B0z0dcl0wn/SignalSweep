        const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_RX_UUID      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_TX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

        const modeNames = {
            0: "Mode Selector",
            1: "Beacon Bandit",
            2: "War Flocking",
            3: "Sky Sweeper"
        };

        let currentActiveMode = -1;
        let connectionType = null; // 'BLE' | 'Serial' | null
        
        let map = null;
        let polyline = null;
        let warFlockingPath = [];
        let warFlockingMarkers = {};

        function initMap() {
            if (!window.L) return;
            if (map) return;
            map = window.L.map('map-container').setView([0, 0], 15);
            
            const baseLayer = window.tileLayerOffline('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap',
                subdomains: 'abc',
                minZoom: 3,
                maxZoom: 20
            }).addTo(map);

            const saveControl = window.savetiles(baseLayer, {
                zoomlevels: [13, 14, 15, 16, 17, 18],
                alwaysDownload: false,
                confirm(status, successCallback) {
                    if (window.confirm(`Download ${status._tilesforSave.length} tiles for offline mapping?`)) {
                        successCallback();
                    }
                },
                confirmRemoval(status, successCallback) {
                    if (window.confirm('Delete all offline cached map tiles?')) {
                        successCallback();
                    }
                },
                saveText: '💾',
                rmText: '🗑️'
            });
            saveControl.addTo(map);

            let progress = 0;
            let total = 0;
            baseLayer.on('savestart', (e) => {
                progress = 0;
                total = e._tilesforSave.length;
                document.getElementById('offline-progress-wrapper').style.display = 'block';
                document.getElementById('offline-progress-bar').style.width = '0%';
            });
            baseLayer.on('loadtileend', () => {
                progress += 1;
                document.getElementById('offline-progress-bar').style.width = `${(progress / total) * 100}%`;
                if (progress === total) {
                    setTimeout(() => {
                        document.getElementById('offline-progress-wrapper').style.display = 'none';
                        showToast('Offline map area saved!', '✓');
                    }, 1000);
                }
            });

            polyline = window.L.polyline([], {color: '#00f2fe'}).addTo(map);
        }

        let globalPhoneLocation = null;
        let gpsInitialized = false;

        function initGPS() {
            if (gpsInitialized) return;
            if (window.Geolocation) {
                window.Geolocation.requestPermissions().then((status) => {
                    if (status.location === 'granted' || status.coarseLocation === 'granted') {
                        gpsInitialized = true;
                        window.Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
                            if (pos) {
                                globalPhoneLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                                if (currentActiveMode === 2 && map && polyline) {
                                    const latlng = [pos.coords.latitude, pos.coords.longitude];
                                    warFlockingPath.push(latlng);
                                    polyline.setLatLngs(warFlockingPath);
                                    map.setView(latlng);
                                }
                            }
                        });
                    } else {
                        console.error('Geolocation permission denied');
                        showToast('Location permission denied!', '✕');
                    }
                }).catch(err => console.error(err));
            }
        }

        function setupGeiger() {
            const geigerContainer = document.getElementById('geiger-container');
            const toggle = document.getElementById('geiger-toggle');

            toggle.addEventListener('click', () => {
                geigerEnabled = !geigerEnabled;
                if (geigerEnabled) {
                    toggle.classList.add('active');
                    geigerContainer.classList.add('active');
                } else {
                    toggle.classList.remove('active');
                    geigerContainer.classList.remove('active');
                    updateGeigerUI(-100);
                }
            });
        }

        let gattProfileCache = {};
        let lastBanditData = null;

        function translateUUID(uuid) {
            const shortUuid = uuid.length === 36 ? uuid.split('-')[0].replace(/^0+/, '') : uuid;
            const uuids = {
                '1800': 'Generic Access',
                '1801': 'Generic Attribute',
                '180a': 'Device Information',
                '180f': 'Battery Service',
                '2a00': 'Device Name',
                '2a29': 'Manufacturer Name',
                '2a24': 'Model Number',
                '2a26': 'Firmware Revision',
                '2a27': 'Hardware Revision',
                '2a19': 'Battery Level'
            };
            return uuids[shortUuid.toLowerCase()] || 'Proprietary';
        }

        function processIncomingData(dataStr) {
            try {
                let data = JSON.parse(dataStr);
                
                if (data.event === 'gatt_profile') {
                    let html = `<div style="margin-top: 15px; padding: 12px; background: rgba(0, 242, 254, 0.03); border: 1px solid rgba(0, 242, 254, 0.15); border-radius: 8px; font-family: monospace;">`;
                    html += `<h4 style="color: var(--accent-cyan); margin-bottom: 8px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px;">GATT Interrogation Dossier</h4>`;
                    
                    if (data.services && data.services.length > 0) {
                        data.services.forEach(srv => {
                            let srvName = translateUUID(srv.uuid);
                            html += `<div style="margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 5px;">`;
                            html += `<div style="font-size: 0.85rem; font-weight: bold; color: var(--accent-emerald);">${srvName} <span style="color: var(--text-muted); font-size: 0.7rem; font-weight: normal;">(${srv.uuid})</span></div>`;
                            
                            if (srv.characteristics) {
                                srv.characteristics.forEach(ch => {
                                    let chName = translateUUID(ch.uuid);
                                    html += `<div style="margin-left: 12px; font-size: 0.75rem; color: var(--text-color); margin-top: 4px;">`;
                                    
                                    // Make it beep exploit!
                                    if (srv.uuid.toLowerCase() === '1802' && ch.uuid.toLowerCase() === '2a06') {
                                        html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                                    <div><span style="color: var(--text-muted);">└─</span> ${chName} <span style="color: var(--text-muted); font-size: 0.65rem;">(${ch.uuid})</span></div>
                                                    <button onclick="triggerBleWrite('${data.mac}', '${srv.uuid}', '${ch.uuid}', '02')" style="background: rgba(255, 50, 50, 0.2); border: 1px solid rgba(255, 50, 50, 0.6); color: #ff6b6b; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; font-weight: bold; animation: pulse 2s infinite;">RING ALARM</button>
                                                 </div>`;
                                    } else {
                                        let writeUI = '';
                                        if (ch.properties && (ch.properties.includes('Write') || ch.properties.includes('WriteNoResponse'))) {
                                            let inputId = `write_${data.mac.replace(/:/g,'')}_${ch.uuid}`;
                                            writeUI = `<div style="display: flex; gap: 5px; margin-top: 4px; margin-left: 20px;">
                                                        <input type="text" id="${inputId}" placeholder="HEX (e.g. 0A FF)" style="flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(0,242,254,0.3); color: white; padding: 2px 5px; font-size: 0.7rem; border-radius: 3px;">
                                                        <button onclick="let v=document.getElementById('${inputId}').value; if(v) triggerBleWrite('${data.mac}', '${srv.uuid}', '${ch.uuid}', v.replace(/\\s/g,''))" style="background: rgba(0,242,254,0.1); border: 1px solid var(--accent-cyan); color: var(--accent-cyan); padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 0.7rem;">WRITE</button>
                                                       </div>`;
                                        }
                                        
                                        html += `<div><span style="color: var(--text-muted);">└─</span> ${chName} <span style="color: var(--text-muted); font-size: 0.65rem;">(${ch.uuid})</span></div>`;
                                        if (ch.value_hex) {
                                            html += `<div style="margin-left: 20px; margin-top: 2px;">`;
                                            html += `<span style="color: var(--accent-amber);">HEX:</span> ${ch.value_hex}<br>`;
                                            html += `<span style="color: var(--accent-cyan);">TXT:</span> ${ch.value_ascii}`;
                                            html += `</div>`;
                                        }
                                        html += writeUI;
                                    }
                                    html += `</div>`;
                                });
                            }
                            html += `</div>`;
                        });
                    } else {
                        html += `<div style="font-size: 0.8rem; color: var(--accent-amber);">No readable services found or connection dropped.</div>`;
                    }
                    html += `</div>`;
                    
                    gattProfileCache[data.mac] = html;
                    
                    if (currentActiveMode === 1 && lastBanditData) {
                        renderTargets(1, lastBanditData.targets);
                    }
                    return;
                }

                if (data.mode === 0) {
                    updateActiveUI(0);
                } else if (data.mode === 1) {
                    if (data.targets) {
                        lastBanditData = data;
                        renderTargets(1, data.targets);
                    }
                } else if (data.mode === 2) {
                    // War Flocking logic...
                }
            } catch (e) {
                console.warn('Data parse error:', e);
            }
        }

        let isMapFullscreen = false;
        function toggleMapFullscreen() {
            const ui = document.getElementById('war-flocking-ui');
            const mapContainer = document.getElementById('map-container');
            
            if (!isMapFullscreen) {
                ui.style.position = 'fixed';
                ui.style.top = '0';
                ui.style.left = '0';
                ui.style.width = '100vw';
                ui.style.height = '100vh';
                ui.style.zIndex = '9999';
                ui.style.background = 'var(--bg-color)';
                ui.style.padding = '20px';
                ui.style.boxSizing = 'border-box';
                mapContainer.style.height = 'calc(100vh - 100px)';
                isMapFullscreen = true;
            } else {
                ui.style.position = 'static';
                ui.style.width = '100%';
                ui.style.height = 'auto';
                ui.style.zIndex = 'auto';
                ui.style.background = 'transparent';
                ui.style.padding = '0';
                mapContainer.style.height = '350px';
                isMapFullscreen = false;
            }
            if (map) {
                setTimeout(() => { map.invalidateSize(); }, 100);
            }
        }
    
        function exportOSM() {
            const targets = Object.values(trackedTargets);
            if (targets.length === 0) {
                showToast('No targets logged yet.', '✕');
                return;
            }

            let osm = `<?xml version='1.0' encoding='UTF-8'?>\n<osm version="0.6" generator="SignalSweep">\n`;
            let idCounter = -1; // Negative IDs for new elements

            targets.forEach(t => {
                const lat = warFlockingPath.length > 0 ? warFlockingPath[warFlockingPath.length-1][0] : 0;
                const lon = warFlockingPath.length > 0 ? warFlockingPath[warFlockingPath.length-1][1] : 0;
                
                osm += `  <node id="${idCounter}" lat="${lat}" lon="${lon}">\n`;
                osm += `    <tag k="man_made" v="surveillance"/>\n`;
                osm += `    <tag k="surveillance:type" v="ALPR"/>\n`;
                osm += `    <tag k="manufacturer" v="Flock Safety"/>\n`;
                osm += `    <tag k="name" v="${t.n || t.m}"/>\n`;
                osm += `    <tag k="mac" v="${t.m}"/>\n`;
                osm += `  </node>\n`;
                idCounter--;
            });

            osm += `</osm>`;
            
            const element = document.createElement('a');
            element.setAttribute('href', 'data:text/xml;charset=utf-8,' + encodeURIComponent(osm));
            element.setAttribute('download', `flock_targets_${new Date().getTime()}.osm`);
            element.style.display = 'none';
            document.body.appendChild(element);
            element.click();
            document.body.removeChild(element);
            showToast('OSM Export Downloaded!', '✓');
        }

        let bleDevice = null;
        let gattServer = null;
        let rxCharacteristic = null;
        let txCharacteristic = null;
        let serialPort = null;
        let serialReader = null;
        let serialWriter = null;
        let rxBuffer = '';

        // Check browser capabilities
        function checkApiSupport() {
            const bleBadge = document.getElementById('bleSupportBadge');
            const serialBadge = document.getElementById('serialSupportBadge');

            if ('bluetooth' in navigator) {
                bleBadge.className = 'api-badge ok';
                bleBadge.textContent = 'Supported';
            } else {
                bleBadge.className = 'api-badge warn';
                bleBadge.textContent = 'Not Supported';
            }

            if ('serial' in navigator) {
                serialBadge.className = 'api-badge ok';
                serialBadge.textContent = 'Supported';
            } else {
                serialBadge.className = 'api-badge warn';
                serialBadge.textContent = 'Not Supported';
            }
        }

        function openConnModal() {
            document.getElementById('connModal').classList.add('active');
        }

        function closeConnModal() {
            document.getElementById('connModal').classList.remove('active');
        }

        function updateConnectionUI(isConnected, type = '') {
            const pulseDot = document.getElementById('pulseDot');
            const connStatusText = document.getElementById('connStatusText');
            const btnConnectHeader = document.getElementById('btnConnectHeader');
            const btnDisconnectHeader = document.getElementById('btnDisconnectHeader');
            const connBanner = document.getElementById('connBanner');

            if (isConnected) {
                connectionType = type;
                pulseDot.className = 'pulse-dot connected';
                connStatusText.textContent = `CONNECTED (${type})`;
                btnConnectHeader.style.display = 'none';
                btnDisconnectHeader.style.display = 'block';
                connBanner.style.display = 'none';
                closeConnModal();
                showToast(`Connected via ${type}`, '✓');
            } else {
                connectionType = null;
                pulseDot.className = 'pulse-dot';
                connStatusText.textContent = 'DISCONNECTED';
                btnConnectHeader.style.display = 'flex';
                btnDisconnectHeader.style.display = 'none';
                connBanner.style.display = 'flex';
                showToast('Device disconnected', '✕');
            }
        }

        // Web Bluetooth Connection
        
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

        async function connectWebBluetooth() {
            if (window.Capacitor && window.Capacitor.isNativePlatform()) {
                await connectNativeBluetooth();
                return;
            }
            if (!('bluetooth' in navigator)) {
                alert('Web Bluetooth API is not supported by your browser. Please use Google Chrome, Microsoft Edge, or Opera.');
                return;
            }

            const pulseDot = document.getElementById('pulseDot');
            const connStatusText = document.getElementById('connStatusText');
            pulseDot.className = 'pulse-dot connecting';
            connStatusText.textContent = 'CONNECTING BLE...';

            try {
                // Request BLE device with NUS service filter or optionalServices fallback
                let device;
                try {
                    device = await navigator.bluetooth.requestDevice({
                        filters: [
                            { services: [NUS_SERVICE_UUID] },
                            { namePrefix: 'SignalSweep' },
                            { namePrefix: 'ESP32' }
                        ],
                        optionalServices: [NUS_SERVICE_UUID]
                    });
                } catch (filterErr) {
                    console.log('Filtered request failed, trying acceptAllDevices fallback:', filterErr);
                    device = await navigator.bluetooth.requestDevice({
                        acceptAllDevices: true,
                        optionalServices: [NUS_SERVICE_UUID]
                    });
                }

                bleDevice = device;
                bleDevice.addEventListener('gattserverdisconnected', onDeviceDisconnected);

                console.log('Connecting to GATT Server...');
                gattServer = await bleDevice.gatt.connect();

                console.log('Getting NUS Service...');
                const service = await gattServer.getPrimaryService(NUS_SERVICE_UUID);

                console.log('Getting RX & TX Characteristics...');
                rxCharacteristic = await service.getCharacteristic(NUS_RX_UUID);
                txCharacteristic = await service.getCharacteristic(NUS_TX_UUID);

                console.log('Starting Notifications on TX...');
                await txCharacteristic.startNotifications();
                txCharacteristic.addEventListener('characteristicvaluechanged', handleBleNotification);

                updateConnectionUI(true, 'BLE');

                // Send request for current status/mode
                sendCommand({ get: 'status' });

            } catch (err) {
                console.error('Web Bluetooth connection failed:', err);
                updateConnectionUI(false);
                if (err.name !== 'NotFoundError') { // Not user cancel
                    showToast(`BLE Connect Failed: ${err.message || err}`, '✕');
                }
            }
        }

        function handleBleNotification(event) {
            const value = event.target.value;
            const decoder = new TextDecoder('utf-8');
            const chunk = decoder.decode(value);
            processIncomingChunk(chunk);
        }

        // WebSerial Connection
        async function connectWebSerial() {
            if (!('serial' in navigator)) {
                alert('WebSerial API is not supported by your browser. Please use Google Chrome, Microsoft Edge, or Opera.');
                return;
            }

            const pulseDot = document.getElementById('pulseDot');
            const connStatusText = document.getElementById('connStatusText');
            pulseDot.className = 'pulse-dot connecting';
            connStatusText.textContent = 'CONNECTING SERIAL...';

            try {
                serialPort = await navigator.serial.requestPort();
                await serialPort.open({ baudRate: 115200 });

                serialPort.addEventListener('disconnect', onDeviceDisconnected);

                // Pipe readable stream to text decoder
                const textDecoder = new TextDecoderStream();
                serialPort.readable.pipeTo(textDecoder.writable);
                serialReader = textDecoder.readable.getReader();

                // Pipe writable stream to text encoder
                const textEncoder = new TextEncoderStream();
                textEncoder.readable.pipeTo(serialPort.writable);
                serialWriter = textEncoder.writable.getWriter();

                updateConnectionUI(true, 'SERIAL');

                // Send request for current status/mode
                sendCommand({ get: 'status' });

                // Start async serial reading loop
                readSerialLoop();

            } catch (err) {
                console.error('WebSerial connection failed:', err);
                updateConnectionUI(false);
                if (err.name !== 'NotFoundError') {
                    showToast(`Serial Connect Failed: ${err.message || err}`, '✕');
                }
            }
        }

        async function readSerialLoop() {
            try {
                while (serialReader) {
                    const { value, done } = await serialReader.read();
                    if (done) {
                        break;
                    }
                    if (value) {
                        processIncomingChunk(value);
                    }
                }
            } catch (err) {
                console.error('Serial read loop error:', err);
            } finally {
                onDeviceDisconnected();
            }
        }

        // Process incoming stream chunks and split by newline
        function processIncomingChunk(chunk) {
            rxBuffer += chunk;
            let lines = rxBuffer.split('\n');
            rxBuffer = lines.pop(); // Keep last incomplete fragment in buffer

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    processIncomingData(trimmed);
                }
            }
        }

        function handleDeviceData(data) {
            if (typeof data.mode === 'number') {
                updateActiveUI(data.mode);
            }
            if (Array.isArray(data.targets)) {
                renderTargets(currentActiveMode >= 0 ? currentActiveMode : (data.mode || 1), data.targets);
            }
            // Removed periodic status toast to prevent spam
        }

        // Send Command to ESP32 over BLE or Serial
        async function sendCommand(cmdObj) {
            const jsonStr = JSON.stringify(cmdObj) + '\n';
            console.log('Sending command:', jsonStr);

            if (connectionType === 'BLE') {
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
                } catch (err) {
                    console.error('BLE write error:', err);
                    showToast(`BLE Transmit Error: ${err.message}`, '✕');
                    return false;
                }
            } else if (connectionType === 'SERIAL' && serialWriter) {
                try {
                    await serialWriter.write(jsonStr);
                    return true;
                } catch (err) {
                    console.error('Serial write error:', err);
                    showToast(`Serial Transmit Error: ${err.message}`, '✕');
                    return false;
                }
            } else {
                openConnModal();
                showToast('Please connect to device first', '✕');
                return false;
            }
        }

        async function disconnectDevice() {
            if (bleDevice) {
                if (bleDevice.gatt && bleDevice.gatt.connected) {
                    bleDevice.gatt.disconnect();
                } else if (window.BleClient && bleDevice.deviceId) {
                    try { await window.BleClient.disconnect(bleDevice.deviceId); } catch(e) { console.error(e); }
                }
            }
            if (serialReader) {
                try { await serialReader.cancel(); } catch (e) {}
                serialReader = null;
            }
            if (serialWriter) {
                try { await serialWriter.close(); } catch (e) {}
                serialWriter = null;
            }
            if (serialPort) {
                try { await serialPort.close(); } catch (e) {}
                serialPort = null;
            }
            onDeviceDisconnected();
        }

        function onDeviceDisconnected() {
            bleDevice = null;
            gattServer = null;
            rxCharacteristic = null;
            txCharacteristic = null;
            serialPort = null;
            serialReader = null;
            serialWriter = null;
            updateConnectionUI(false);
        }

        function updateActiveUI(activeMode) {
            currentActiveMode = activeMode;

            // Update Cards
            for (let i = 0; i <= 3; i++) {
                const cardEl = document.getElementById(`card-${i}`);
                const btnTextEl = document.getElementById(`btn-text-${i}`);

                if (cardEl && btnTextEl) {
                    if (i === activeMode) {
                        cardEl.classList.add('active');
                        btnTextEl.textContent = 'ACTIVE';
                    } else {
                        cardEl.classList.remove('active');
                        btnTextEl.textContent = `Activate Mode ${i}`;
                    }
                }
            }

            // Update Live Data Section
            const dataContainer = document.getElementById('mode-data-container');
            const dataTitle = document.getElementById('mode-data-title');

            if (activeMode > 0) {
                dataContainer.style.display = 'block';
                dataTitle.textContent = `${modeNames[activeMode]} - Live Targets`;
                document.getElementById('targets-list').innerHTML = '<div class="mode-card" style="text-align:center; padding: 2rem; color: var(--text-muted); display: block; border-style: dashed;">Switching modes... clearing previous targets...</div>';
            } else {
                dataContainer.style.display = 'none';
                document.getElementById('targets-list').innerHTML = '';
            }
        }

        const radarAngles = {};
        
        let currentViewMode = 'list';
        let detectedDevices = [];

        function toggleViewMode(mode) {
            currentViewMode = mode;
            const btnList = document.getElementById('btn-list-view');
            const btnRadar = document.getElementById('btn-radar-view');
            if(btnList) btnList.className = mode === 'list' ? 'btn-conn-option primary' : 'btn-conn-option';
            if(btnRadar) btnRadar.className = mode === 'radar' ? 'btn-conn-option primary' : 'btn-conn-option';
            
            const listEl = document.getElementById('targets-list');
            const radarEl = document.getElementById('radarCanvas');
            
            if (mode === 'list') {
                if(listEl) listEl.style.display = 'block';
                if(radarEl) radarEl.style.display = 'none';
            } else {
                if(listEl) listEl.style.display = 'none';
                if(radarEl) radarEl.style.display = 'block';
                drawRadar();
            }
        }

        function drawRadar() {
            const canvas = document.getElementById('radarCanvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const width = canvas.width;
            const height = canvas.height;
            const centerX = width / 2;
            const centerY = height / 2;
            const maxRadius = width / 2;

            ctx.clearRect(0, 0, width, height);

            ctx.strokeStyle = 'rgba(0, 242, 254, 0.3)';
            ctx.lineWidth = 1;
            for (let i = 1; i <= 3; i++) {
                ctx.beginPath();
                ctx.arc(centerX, centerY, (maxRadius / 3) * i, 0, 2 * Math.PI);
                ctx.stroke();
            }
            ctx.beginPath();
            ctx.moveTo(centerX, 0);
            ctx.lineTo(centerX, height);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, centerY);
            ctx.lineTo(width, centerY);
            ctx.stroke();

            detectedDevices.forEach(device => {
                const mac = device.mac || 'unknown';
                if (!radarAngles[mac]) radarAngles[mac] = Math.random() * Math.PI * 2;
                const angle = radarAngles[mac];
                
                const rssi = device.rssi || -100;
                let distRatio = (rssi - (-30)) / (-100 - (-30));
                distRatio = Math.max(0, Math.min(1, distRatio));
                const r = distRatio * (maxRadius - 10);

                const x = centerX + r * Math.cos(angle);
                const y = centerY + r * Math.sin(angle);

                ctx.beginPath();
                ctx.arc(x, y, 5, 0, 2 * Math.PI);
                ctx.fillStyle = '#ff0055';
                ctx.fill();
                ctx.shadowBlur = 10;
                ctx.shadowColor = '#ff0055';

                ctx.fillStyle = '#fff';
                ctx.font = '10px Arial';
                ctx.shadowBlur = 0;
                const name = device.name || device.type || mac;
                ctx.fillText(name.substring(0, 8), x + 8, y + 4);
            });
        }

        function exportAIDebrief() {
            let text = "I have scanned an environment and detected the following hardware. Please analyze for unusual surveillance...\n\n";
            let date = new Date().toISOString();
            text += `Scan Date: ${date}\n\n`;
            if (detectedDevices.length === 0) {
                text += "No devices detected yet.";
            } else {
                detectedDevices.forEach(d => {
                    text += `- MAC: ${d.mac || 'N/A'}, Name: ${d.name || d.type || 'Unknown'}, RSSI: ${d.rssi || 'N/A'} dBm, Type: ${d.type || 'N/A'}\n`;
                });
            }
            
            // Save to localStorage, keep last 5
            try {
                let reports = JSON.parse(localStorage.getItem('ai_reports') || '[]');
                reports.push({ date: date, content: text });
                if (reports.length > 5) {
                    reports = reports.slice(reports.length - 5);
                }
                localStorage.setItem('ai_reports', JSON.stringify(reports));
            } catch (e) {
                console.error("Local storage error:", e);
            }

            // Download as .txt file
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `AI_Debrief_${date.replace(/[:.]/g, '-')}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Also copy to clipboard for convenience
            navigator.clipboard.writeText(text).then(() => {
                showToast("Debrief downloaded and copied!", "✓");
            }).catch(err => {
                console.error('Failed to copy', err);
                showToast("Debrief downloaded!", "✓");
            });
        }

        function renderTargets(mode, targets) {
            detectedDevices = targets || [];
            if (currentViewMode === 'radar') {
                drawRadar();
            }
            
            const list = document.getElementById('targets-list');
            const radarContainer = document.getElementById('radar-container');
            
            // Remove existing blips
            if (radarContainer) {
                const existingBlips = radarContainer.querySelectorAll('.radar-blip');
                existingBlips.forEach(b => b.remove());
            }

            if (!targets || targets.length === 0) {
                list.innerHTML = '<div class="mode-card" style="text-align:center; padding: 2rem; color: var(--text-muted); display: block; border-style: dashed;">No targets detected yet... Scanning...</div>';
                return;
            }

            let html = '';
            targets.forEach(t => {
                let name = t.name || t.uas_id || t.type || 'Unknown Target';
                if (mode === 2) name = t.name || 'Surveillance Device';
                let mac = t.mac || '00:00:00:00:00:00';
                let rssi = t.rssi || -99;
                let isLocked = t.is_locked ? 'locked' : '';

                let details = '';
                if (mode === 1) {
                    details = `Type: ${t.type || 'Generic BLE'} | Count: ${t.count || 1}`;
                } else if (mode === 3) {
                    details = `Speed: ${t.speed || 0}m/s | Alt: ${t.altitude || 0}m | Pilot: ${t.operator_id || 'Unknown'} | Src: ${t.source || 'BLE'}`;
                    
                    if (radarContainer) {
                        if (!radarAngles[mac]) radarAngles[mac] = Math.random() * Math.PI * 2;
                        let angle = radarAngles[mac];
                        
                        let isTrueBearing = false;
                        if (globalPhoneLocation && t.latitude && t.longitude && t.latitude !== 0 && t.longitude !== 0) {
                            const dLon = (t.longitude - globalPhoneLocation.lng) * (Math.PI / 180);
                            const lat1 = globalPhoneLocation.lat * (Math.PI / 180);
                            const lat2 = t.latitude * (Math.PI / 180);
                            const by = Math.sin(dLon) * Math.cos(lat2);
                            const bx = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
                            angle = Math.atan2(by, bx);
                            isTrueBearing = true;
                        }

                        let distance = 140 - Math.max(0, Math.min(140, (rssi + 90) * (140/60)));
                        let blipX = 150 + (isTrueBearing ? Math.sin(angle) : Math.cos(angle)) * distance;
                        let blipY = 150 + (isTrueBearing ? -Math.cos(angle) : Math.sin(angle)) * distance;
                        
                        const blip = document.createElement('div');
                        blip.className = 'radar-blip';
                        blip.style.left = `${blipX}px`;
                        blip.style.top = `${blipY}px`;
                        radarContainer.appendChild(blip);
                    }
                } else if (mode === 2) {
                    details = `Type: ${t.type || 'Flock/Raven'} | Count: ${t.count || 1}`;
                }

                let gattHtml = '';
                if (mode === 1 && t.is_locked) {
                    if (gattProfileCache[mac]) {
                        gattHtml = gattProfileCache[mac];
                    } else {
                        gattHtml = `<div style="margin-top: 15px; font-size: 0.8rem; color: var(--accent-amber); animation: pulse-op 1s infinite alternate; font-family: monospace;">[!] Establishing BLE connection & Ripping GATT Table...</div>`;
                    }
                }

                let targetLockedText = t.is_locked ? 'LOCKED ON' : 'Tap to Lock';
                let targetLockedColor = t.is_locked ? 'var(--accent-purple)' : 'var(--text-muted)';
                let rssiSectionHtml = '';
                
                if (mode === 1) {
                    rssiSectionHtml = `
                    <div style="text-align: right;">
                        <div style="font-size: 1.25rem; font-weight: bold; color: ${rssi > -60 ? 'var(--accent-emerald)' : (rssi > -80 ? 'var(--accent-amber)' : 'var(--text-muted)')}">${rssi} dBm</div>
                        <div style="font-size: 0.7rem; color: ${targetLockedColor}; margin-top: 0.2rem; font-weight: bold; text-transform: uppercase;">${targetLockedText}</div>
                    </div>`;
                } else {
                     rssiSectionHtml = `
                    <div style="text-align: right;">
                        <div style="font-size: 1.25rem; font-weight: bold; color: ${rssi > -60 ? 'var(--accent-emerald)' : (rssi > -80 ? 'var(--accent-amber)' : 'var(--text-muted)')}">${rssi} dBm</div>
                    </div>`;
                }

                html += `
                <div class="target-card ${mode === 1 ? isLocked : ''}" ${mode === 1 ? `onclick="lockTarget('${mac}', ${t.is_locked})"` : ''}>
                    <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                        <div>
                            <h3 style="color: var(--accent-cyan); margin-bottom: 0.3rem; font-size: 1.1rem;">${name}</h3>
                            <div style="font-size: 0.8rem; color: var(--text-muted)">MAC: ${mac} | ${details}</div>
                        </div>
                        ${rssiSectionHtml}
                    </div>
                    ${gattHtml}
                </div>`;
            });
            list.innerHTML = html;
        }

        async function lockTarget(mac, isCurrentlyLocked) {
            const cmdMac = isCurrentlyLocked ? 'NONE' : mac;
            const success = await sendCommand({ lock: cmdMac });
            if (success) {
                if (isCurrentlyLocked) {
                    showToast(`Unlocked target`, '✓');
                } else {
                    showToast(`Target lock requested for ${mac}`, '✓');
                }
            }
        }

        async function switchMode(modeInt) {
            if (modeInt === currentActiveMode) {
                if (modeInt === 1) {
                    await lockTarget('NONE');
                    showToast('Unlocked target', '✓');
                }
                return;
            }

            // Always clear lock and gatt cache when switching away from mode 1
            if (currentActiveMode === 1) {
                await lockTarget('NONE');
                gattProfileCache = {};
            }

            const btnTextEl = document.getElementById(`btn-text-${modeInt}`);
            if (btnTextEl) btnTextEl.textContent = 'Switching...';

            const success = await sendCommand({ mode: modeInt });
            if (success) {
                updateActiveUI(modeInt);
                showToast(`Switched to ${modeNames[modeInt]}`, '✓');
                
                // Show/hide filter toggle depending on mode
                document.getElementById('bandit-filter-container').style.display = (modeInt === 1) ? 'flex' : 'none';
                
                // Show/hide map depending on mode
                document.getElementById('war-flocking-ui').style.display = (modeInt === 2) ? 'flex' : 'none';
                if (modeInt === 2) {
                    initGPS();
                    if (!map) setTimeout(initMap, 100);
                }

                // Show/hide sky sweeper radar depending on mode
                document.getElementById('sky-sweeper-ui').style.display = (modeInt === 3) ? 'flex' : 'none';
                document.getElementById('spoof-engine-ui').style.display = (modeInt === 1) ? 'flex' : 'none';
                if (modeInt === 3) {
                    initGPS();
                }
            } else {
                updateActiveUI(currentActiveMode);
            }
        }

        async function toggleFilter(isActive) {
            const success = await sendCommand({ filter: isActive });
            if (success) {
                showToast(`Filter ${isActive ? 'ON' : 'OFF'}`, '✓');
            } else {
                document.getElementById('filterToggle').checked = !isActive;
            }
        }

        async function triggerBleWrite(mac, service, char, hexVal) {
            showToast('Sending BLE Write Command...', '⚡');
            await sendCommand({
                action: 'ble_write',
                mac: mac,
                service: service,
                char: char,
                val: hexVal
            });
        }

        async function triggerSpoof(payload) {
            showToast('Blasting Spoof Payload for 10s...', '☠️');
            await sendCommand({
                action: 'ble_spoof',
                payload: payload
            });
        }

        function showToast(msg, icon = '✓') {
            const toast = document.getElementById('toast');
            const toastMsg = document.getElementById('toast-msg');
            const toastIcon = document.getElementById('toast-icon');

            if (toast && toastMsg && toastIcon) {
                toastMsg.textContent = msg;
                toastIcon.textContent = icon;
                toast.classList.add('show');
                setTimeout(() => {
                    toast.classList.remove('show');
                }, 3000);
            }
        }

        // Initialize UI on page load
        document.addEventListener('DOMContentLoaded', () => {
            checkApiSupport();
            // Show connection modal if disconnected on start
            setTimeout(() => {
                if (!connectionType) {
                    openConnModal();
                }
            }, 600);

            // Handle hardware back button
            setTimeout(() => {
                if (window.App) {
                    window.App.addListener('backButton', () => {
                        if (typeof isMapFullscreen !== 'undefined' && isMapFullscreen) {
                            toggleMapFullscreen();
                        } else {
                            window.App.exitApp();
                        }
                    });
                }
            }, 1000);
        });
