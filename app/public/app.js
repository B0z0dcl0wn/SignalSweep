        const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_RX_UUID      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_TX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

        const modeNames = {
            0: "Mode Selector",
            1: "Beacon Bandit",
            2: "War Flocking",
            3: "Sky Sweeper",
            4: "Shadow"
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

        // ---- Shadow (tail detection) -------------------------------------
        // The device reports what it hears; the phone knows where it is. A tail
        // is a MAC that reappears near you at several *separate places*, not one
        // that's merely loud. So we bucket each sighting into a GPS cluster and
        // score on how many distinct clusters a device shows up in.
        const SHADOW_CLUSTER_M = 200;   // >200m apart = a different place
        const SHADOW_ALERT_CLUSTERS = 3;
        let shadowSeen = {};            // mac -> {clusters:[{lat,lng}], first,last,rssi,name,proto,count}

        function haversineM(a, b) {
            const R = 6371000, toRad = d => d * Math.PI / 180;
            const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
            const s = Math.sin(dLat / 2) ** 2 +
                      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(s));
        }

        // Fold one sighting into a device's record. Returns the updated record.
        function shadowRecord(store, mac, loc, now, extra) {
            const rec = store[mac] || { clusters: [], first: now, last: now, count: 0,
                                        rssi: -99, name: '', proto: '' };
            rec.last = now;
            rec.count++;
            if (extra) {
                if (extra.rssi != null) rec.rssi = extra.rssi;
                if (extra.name) rec.name = extra.name;
                if (extra.proto) rec.proto = extra.proto;
            }
            if (loc && loc.lat != null && loc.lng != null) {
                const near = rec.clusters.some(c => haversineM(c, loc) <= SHADOW_CLUSTER_M);
                if (!near) rec.clusters.push({ lat: loc.lat, lng: loc.lng });
            }
            store[mac] = rec;
            return rec;
        }

        // 0-100. Distinct places dominate; span of time and total distance help.
        function shadowScore(rec, now) {
            const places = rec.clusters.length;
            if (places < 2) return 0;   // one place is a neighbour, not a tail
            let spreadM = 0;
            for (let i = 0; i < rec.clusters.length; i++)
                for (let j = i + 1; j < rec.clusters.length; j++)
                    spreadM = Math.max(spreadM, haversineM(rec.clusters[i], rec.clusters[j]));
            const minutes = Math.max(0, ((now || rec.last) - rec.first) / 60000);
            const score = (places - 1) * 30
                        + Math.min(30, spreadM / 100)
                        + Math.min(20, minutes);
            return Math.max(0, Math.min(100, Math.round(score)));
        }

        // ponytail: runnable self-check for the clustering/scoring above —
        // window.__shadowSelfTest() in the console returns true if sane.
        window.__shadowSelfTest = function () {
            const s = {}, t0 = 0;
            const A = { lat: 30.2200, lng: -92.0200 };          // origin
            const B = { lat: 30.2400, lng: -92.0200 };          // ~2.2 km north
            const C = { lat: 30.2600, lng: -92.0200 };          // ~4.4 km north
            // stationary device: many hits, one place -> not a tail
            for (let i = 0; i < 20; i++) shadowRecord(s, 'AA', A, t0 + i * 1000, { rssi: -50 });
            const stationary = shadowScore(s['AA'], t0 + 20000);
            // follower: same MAC at three distinct places over 20 min
            shadowRecord(s, 'BB', A, t0, { rssi: -60 });
            shadowRecord(s, 'BB', B, t0 + 600000, { rssi: -65 });
            const two = shadowScore(s['BB'], t0 + 600000);
            shadowRecord(s, 'BB', C, t0 + 1200000, { rssi: -62 });
            const three = shadowScore(s['BB'], t0 + 1200000);
            const nearby = haversineM(A, { lat: 30.2201, lng: -92.0200 }) < SHADOW_CLUSTER_M;
            const ok = stationary === 0 && s['AA'].clusters.length === 1 &&
                       s['BB'].clusters.length === 3 && three > two && two > 0 && nearby;
            console.log('[shadow self-test]', { stationary, two, three,
                        clustersAA: s['AA'].clusters.length, clustersBB: s['BB'].clusters.length, ok });
            return ok;
        };

        // Whitelist: your own gear (car AP, phone, earbuds) travels every place
        // you do, so it always scores as a "tail". Mark it yours once and Shadow
        // filters it out for good — what's left is genuinely foreign. Per-viewer,
        // persisted on the phone.
        let shadowWhitelist = new Set();
        try { shadowWhitelist = new Set(JSON.parse(localStorage.getItem('shadowWhitelist') || '[]')); } catch (e) {}

        function shadowWhitelistSave() {
            try { localStorage.setItem('shadowWhitelist', JSON.stringify([...shadowWhitelist])); } catch (e) {}
        }
        function shadowWhitelistAdd(mac) {
            shadowWhitelist.add(mac);
            delete shadowSeen[mac];          // drop its history so it stops scoring
            shadowWhitelistSave();
            showToast('Marked as yours — hidden from Shadow', '✓');
            shadowRenderList();
        }
        function shadowWhitelistClear() {
            shadowWhitelist.clear();
            shadowWhitelistSave();
            showToast('Whitelist cleared', '✓');
            shadowRenderList();
        }
        window.shadowWhitelistAdd = shadowWhitelistAdd;
        window.shadowWhitelistClear = shadowWhitelistClear;

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
                                    
                                    // Ring/Find: if the tracker exposes the Immediate Alert
                                    // Service (0x1802/0x2A06), offer a button to make it chirp
                                    // so it can be physically located and removed.
                                    if (srv.uuid.toLowerCase() === '1802' && ch.uuid.toLowerCase() === '2a06') {
                                        html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                                    <div><span style="color: var(--text-muted);">└─</span> ${chName} <span style="color: var(--text-muted); font-size: 0.65rem;">(${ch.uuid})</span></div>
                                                    <button onclick="triggerBleWrite('${data.mac}', '${srv.uuid}', '${ch.uuid}', '02')" style="background: rgba(0, 242, 254, 0.15); border: 1px solid var(--accent-cyan); color: var(--accent-cyan); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; font-weight: bold;">🔔 RING / FIND</button>
                                                 </div>`;
                                    } else {
                                        html += `<div><span style="color: var(--text-muted);">└─</span> ${chName} <span style="color: var(--text-muted); font-size: 0.65rem;">(${ch.uuid})</span></div>`;
                                        if (ch.value_hex) {
                                            html += `<div style="margin-left: 20px; margin-top: 2px;">`;
                                            html += `<span style="color: var(--accent-amber);">HEX:</span> ${ch.value_hex}<br>`;
                                            html += `<span style="color: var(--accent-cyan);">TXT:</span> ${ch.value_ascii}`;
                                            html += `</div>`;
                                        }
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
                    // Clear Target is the only way out when the locked device
                    // stops advertising and drops off the list.
                    const btnClear = document.getElementById('btn-clear-lock');
                    if (btnClear) btnClear.style.display = data.locked_mac ? 'block' : 'none';
                } else if (data.mode === 2) {
                    // War Flocking: render the surveillance list (map trail is driven by GPS).
                    if (data.targets) renderTargets(2, data.targets);
                } else if (data.mode === 3) {
                    // Sky Sweeper: render the drone list (radar blips handled in renderTargets).
                    if (data.targets) renderTargets(3, data.targets);
                } else if (data.mode === 4) {
                    // Shadow: fold each sighting into its GPS cluster and render tails.
                    if (data.targets) renderShadow(data.targets);
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
        
        // Subscribe to TX notifications for a native BLE device (shared by
        // connect and by reconcileConnection after a resume).
        async function subscribeNative(deviceId) {
            await window.BleClient.startNotifications(
                deviceId,
                NUS_SERVICE_UUID,
                NUS_TX_UUID,
                (value) => {
                    const chunk = new TextDecoder('utf-8').decode(value.buffer);
                    processIncomingChunk(chunk);
                }
            );
        }

        async function connectNativeBluetooth() {
            const pulseDot = document.getElementById('pulseDot');
            const connStatusText = document.getElementById('connStatusText');
            pulseDot.className = 'pulse-dot connecting';
            connStatusText.textContent = 'CONNECTING NATIVE BLE...';

            try {
                await window.BleClient.initialize({ androidNeverForLocation: true });

                // The native link can already be up (e.g. after backgrounding) —
                // and a still-connected device stops advertising, so a fresh scan
                // would find nothing. Reattach to an existing connection first.
                const existing = await window.BleClient.getConnectedDevices([NUS_SERVICE_UUID]);
                let device = existing && existing[0];

                if (!device) {
                    device = await window.BleClient.requestDevice({
                        services: [NUS_SERVICE_UUID],
                        optionalServices: [NUS_SERVICE_UUID]
                    });
                    await window.BleClient.connect(device.deviceId, () => onDeviceDisconnected());
                } else {
                    try { await window.BleClient.connect(device.deviceId, () => onDeviceDisconnected()); } catch (e) { /* already connected */ }
                }

                bleDevice = device;
                try { localStorage.setItem('lastDeviceId', device.deviceId); } catch (e) {}
                await subscribeNative(device.deviceId);

                updateConnectionUI(true, 'BLE');
                sendCommand({ get: 'status' });
            } catch (err) {
                console.error('Native BLE Connect Failed:', err);
                updateConnectionUI(false);
                showToast(`Native BLE Connect Failed: ${err.message || err}`, '✕');
            }
        }

        // Re-sync the app's connection state with the actual native BLE link.
        // The JS/UI state can drift from reality across background/resume (the
        // native connection survives with no disconnect callback), leaving the
        // app showing "disconnected" while still connected. Called on resume.
        async function reconcileConnection() {
            if (!(window.Capacitor && window.Capacitor.isNativePlatform() && window.BleClient)) return;
            try {
                const connected = await window.BleClient.getConnectedDevices([NUS_SERVICE_UUID]);
                const device = connected && connected[0];
                if (device) {
                    if (connectionType !== 'BLE' || !bleDevice) {
                        bleDevice = device;
                        try { localStorage.setItem('lastDeviceId', device.deviceId); } catch (e) {}
                        try { await subscribeNative(device.deviceId); } catch (e) { /* already subscribed */ }
                        updateConnectionUI(true, 'BLE');
                        sendCommand({ get: 'status' });
                    }
                } else if (connectionType === 'BLE') {
                    // We think we're connected but the link is really gone.
                    onDeviceDisconnected();
                }
            } catch (e) {
                console.warn('reconcileConnection error:', e);
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
            for (let i = 0; i <= 4; i++) {
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
        
        let detectedDevices = [];

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

            // Beacon Bandit: locked-on target first, then by stalking score.
            if (mode === 1) {
                targets = targets.slice().sort((a, b) =>
                    ((b.is_locked ? 1 : 0) - (a.is_locked ? 1 : 0)) ||
                    ((b.stalking_score || 0) - (a.stalking_score || 0)));
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

                // Confidence badge (Watcher's Watch) / stalking-risk badge (Beacon Bandit)
                let badgeHtml = '';
                if (mode === 2) {
                    const tier = t.tier || 'Possible';
                    const conf = (t.confidence != null) ? t.confidence : 0;
                    const color = tier === 'Confirmed' ? 'var(--accent-red)'
                                : tier === 'Likely' ? 'var(--accent-amber)'
                                : 'var(--text-muted)';
                    badgeHtml = `<span style="margin-left:8px; font-size:0.65rem; font-weight:bold; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid ${color}; color:${color};">${tier} ${conf}%</span>`;
                } else if (mode === 1 && (t.is_separated || (t.stalking_score || 0) >= 40)) {
                    const sep = t.is_separated ? ' · separated' : '';
                    badgeHtml = `<span style="margin-left:8px; font-size:0.65rem; font-weight:bold; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid var(--accent-red); color:var(--accent-red);">⚠ Stalking ${t.stalking_score || 0}${sep}</span>`;
                }

                html += `
                <div class="target-card ${mode === 1 ? isLocked : ''}" ${mode === 1 ? `onclick="lockTarget('${mac}', ${t.is_locked})"` : ''}>
                    <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                        <div>
                            <h3 style="color: var(--accent-cyan); margin-bottom: 0.3rem; font-size: 1.1rem;">${name}${badgeHtml}</h3>
                            <div style="font-size: 0.8rem; color: var(--text-muted)">MAC: ${mac} | ${details}</div>
                        </div>
                        ${rssiSectionHtml}
                    </div>
                    ${gattHtml}
                </div>`;
            });
            list.innerHTML = html;
        }

        // Shadow: fold a new batch of sightings into the running store, then render.
        function renderShadow(sightings) {
            shadowIngest(sightings);
            shadowRenderList();
        }

        // Fold sightings into the tail store, skipping anything the user has
        // marked as their own.
        function shadowIngest(sightings) {
            const now = Date.now();
            const loc = globalPhoneLocation;   // {lat,lng} from the phone GPS
            (sightings || []).forEach(s => {
                const mac = s.mac || '??';
                if (shadowWhitelist.has(mac)) return;
                shadowRecord(shadowSeen, mac, loc, now,
                    { rssi: s.rssi, name: s.name, proto: s.protocol });
            });
        }

        // Render the current store, ranked by how many distinct places each
        // device has shadowed you. A small bar shows/clears your whitelist.
        function shadowRenderList() {
            const now = Date.now();
            const loc = globalPhoneLocation;
            const list = document.getElementById('targets-list');
            if (!list) return;

            const wlBar = shadowWhitelist.size > 0
                ? `<div style="text-align:center; padding:8px; margin-bottom:10px; font-size:0.75rem; color:var(--text-muted);">${shadowWhitelist.size} device(s) marked yours · <a onclick="shadowWhitelistClear()" style="color:var(--accent-cyan); cursor:pointer; text-decoration:underline;">Clear</a></div>`
                : '';

            if (!loc) {
                list.innerHTML = wlBar + '<div class="mode-card" style="text-align:center; padding:2rem; color:var(--accent-amber); display:block; border-style:dashed;">Waiting for GPS fix — move around and Shadow will flag anything that follows you.</div>';
                return;
            }

            const rows = Object.entries(shadowSeen)
                .filter(([mac]) => !shadowWhitelist.has(mac))
                .map(([mac, rec]) => ({ mac, rec, score: shadowScore(rec, now) }))
                .sort((a, b) => b.score - a.score);

            const tails = rows.filter(r => r.score > 0);
            if (tails.length === 0) {
                list.innerHTML = wlBar + `<div class="mode-card" style="text-align:center; padding:2rem; color:var(--text-muted); display:block; border-style:dashed;">Tracking ${rows.length} device(s) across your route… none seen in 2+ separate places yet.</div>`;
                return;
            }

            let html = wlBar;
            tails.forEach(({ mac, rec, score }) => {
                const alert = rec.clusters.length >= SHADOW_ALERT_CLUSTERS;
                const color = alert ? 'var(--accent-red)' : 'var(--accent-amber)';
                const label = rec.name || (rec.proto === 'WiFi' ? 'Wi-Fi device' : 'BLE device');
                // Tapping a row is how you say "that's mine" — the top hits will
                // be your own car/phone, so this is the primary interaction.
                html += `
                <div class="target-card" style="border-color:${color}; cursor:pointer;" onclick="shadowWhitelistAdd('${mac}')">
                    <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                        <div>
                            <h3 style="color:var(--accent-cyan); margin-bottom:0.3rem; font-size:1.1rem;">${label}
                                <span style="margin-left:8px; font-size:0.65rem; font-weight:bold; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid ${color}; color:${color};">${alert ? '⚠ Following you' : 'Watching'} ${score}</span>
                            </h3>
                            <div style="font-size:0.8rem; color:var(--text-muted)">MAC: ${mac} | ${rec.proto} | seen in ${rec.clusters.length} places | ${rec.count} hits</div>
                            <div style="font-size:0.7rem; color:var(--accent-cyan); margin-top:0.2rem;">tap if this is yours → hide it</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:1.25rem; font-weight:bold; color:${color}">${rec.clusters.length}📍</div>
                            <div style="font-size:0.7rem; color:var(--text-muted)">${rec.rssi} dBm</div>
                        </div>
                    </div>
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

        async function clearTargetLock() {
            if (await sendCommand({ lock: 'NONE' })) {
                showToast('Target cleared', '✓');
                document.getElementById('btn-clear-lock').style.display = 'none';
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
                document.getElementById('btn-clear-lock').style.display = 'none';
                
                // Show/hide map depending on mode
                document.getElementById('war-flocking-ui').style.display = (modeInt === 2) ? 'flex' : 'none';
                if (modeInt === 2) {
                    initGPS();
                    if (!map) setTimeout(initMap, 100);
                }

                // Show/hide sky sweeper radar depending on mode
                document.getElementById('sky-sweeper-ui').style.display = (modeInt === 3) ? 'flex' : 'none';
                if (modeInt === 3) {
                    initGPS();
                }

                // Shadow needs the phone's location to cluster sightings; start
                // fresh each time you enter the mode.
                if (modeInt === 4) {
                    shadowSeen = {};
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
            showToast('Ringing tracker to locate it...', '🔔');
            await sendCommand({
                action: 'ble_write',
                mac: mac,
                service: service,
                char: char,
                val: hexVal
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

        // Re-sync connection state whenever the app returns to the foreground,
        // so a background/resume can't leave the UI stuck on "disconnected"
        // while the native BLE link is still alive.
        if (window.App) {
            window.App.addListener('appStateChange', (state) => {
                if (state && state.isActive) reconcileConnection();
            });
        }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reconcileConnection();
        });

        // Initialize UI on page load
        document.addEventListener('DOMContentLoaded', () => {
            checkApiSupport();
            // Reconcile first (the native link may have survived a page reload),
            // then prompt to connect only if we're really not connected.
            setTimeout(async () => {
                await reconcileConnection();
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
