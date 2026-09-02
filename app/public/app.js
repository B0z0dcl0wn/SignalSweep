        // SignalSweep control app — one always-on detector.
        //
        // Opsec first: this app keeps NO passive trail. It shows what the device
        // is hearing RIGHT NOW and forgets it on close. The only thing that ever
        // persists to disk is (a) tiny UI preferences and (b) location pins you
        // deliberately, per-device, consent to record — and those are stored
        // ONLY as AES-GCM ciphertext behind a PIN. A found phone reveals nothing.

        const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_RX_UUID      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_TX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

        let connectionType = null; // 'BLE' | 'SERIAL' | null

        function esc(v) {
            if (v == null) return '';
            return String(v).replace(/[&<>"']/g, (c) => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        }

        // ---- Category → colour/label (mirrors the firmware buzzer words) -----
        // The device sounds a distinct pattern per category headless; here we
        // just spell it out. Keyword-tolerant so any signature `category` label
        // routes to the right bucket.
        function categoryOf(type) {
            const c = String(type || '').toLowerCase();
            if (c.indexOf('drone') >= 0 || c.indexOf('remote id') >= 0 || c.indexOf('uas') >= 0)
                return { key: 'drone',   label: 'Drone',      color: '#3aa0ff', icon: '🛸' };
            if (c.indexOf('track') >= 0 || c.indexOf('airtag') >= 0 || c.indexOf('tile') >= 0 ||
                c.indexOf('tag') >= 0 || c.indexOf('beacon') >= 0)
                return { key: 'tracker', label: 'Tracker',    color: '#ff3ac8', icon: '📍' };
            if (c.indexOf('body') >= 0 || c.indexOf('axon') >= 0 || c.indexOf('cam') >= 0)
                return { key: 'bodycam', label: 'Body Cam',   color: '#ff5a1a', icon: '🎥' };
            if (c.indexOf('flock') >= 0 || c.indexOf('alpr') >= 0 || c.indexOf('plate') >= 0 || c.indexOf('surveil') >= 0)
                return { key: 'alpr',    label: 'ALPR / Camera', color: '#ef4444', icon: '📷' };
            return { key: 'other', label: (type || 'Match'), color: '#f59e0b', icon: '⚠️' };
        }

        // Signal bar 0-5 from RSSI.
        function signalBars(rssi) {
            const r = Number(rssi);
            let n = 0;
            if (r >= -55) n = 5; else if (r >= -65) n = 4; else if (r >= -75) n = 3;
            else if (r >= -85) n = 2; else if (r >= -95) n = 1; else n = 0;
            return '█'.repeat(n) + '░'.repeat(5 - n);
        }

        // =====================================================================
        //  Live scope — what the device hears RIGHT NOW. Nothing persists.
        // =====================================================================
        // Keyed by MAC, dropped when the device stops reporting it (the firmware
        // prunes at 120 s and only reports matches, so this list IS the matches).
        let liveMatches = {};       // mac -> { mac, name, type, rule, rssi, protocol, confidence, tier, ts }
        const LIVE_STALE_MS = 8000; // hide a match we haven't heard in 8 s

        function ingestTargets(targets) {
            const now = Date.now();
            for (const t of targets) {
                if (!t.mac) continue;
                liveMatches[t.mac] = {
                    mac: t.mac, name: t.name || '', type: t.type || '',
                    rule: t.matched_rule || '', rssi: t.rssi,
                    protocol: t.protocol || 'BLE', confidence: t.confidence || 0,
                    tier: t.tier || '', ts: now
                };
                maybeOfferRecord(liveMatches[t.mac]);
            }
        }

        function renderScope() {
            const list = document.getElementById('targets-list');
            if (!list) return;
            const now = Date.now();
            // Drop stale, then sort strongest-first.
            const rows = Object.values(liveMatches)
                .filter(m => now - m.ts < LIVE_STALE_MS)
                .sort((a, b) => (b.rssi || -999) - (a.rssi || -999));

            const countEl = document.getElementById('scope-count');
            if (countEl) countEl.textContent = rows.length;

            if (rows.length === 0) {
                list.innerHTML = '<div class="scope-empty">' +
                    (connectionType ? 'Listening… nothing matched right now. If the buzzer sounds, look around.'
                                    : 'Connect the device to see live matches. It still beeps on its own without the phone.') +
                    '</div>';
                return;
            }

            let html = '';
            for (const m of rows) {
                const cat = categoryOf(m.type || m.rule);
                const title = m.name || m.rule || cat.label;
                html += '<div class="scope-row" style="border-left:4px solid ' + cat.color + '">' +
                    '<div class="scope-main">' +
                        '<div class="scope-title">' + cat.icon + ' ' + esc(title) +
                            ' <span class="scope-cat" style="color:' + cat.color + '">' + esc(cat.label) + '</span></div>' +
                        '<div class="scope-sub">' + esc(m.mac) + ' · ' + esc(m.protocol) +
                            (m.rule ? ' · ' + esc(m.rule) : '') + ' · conf ' + (m.confidence | 0) + '</div>' +
                    '</div>' +
                    '<div class="scope-signal">' +
                        '<div class="scope-bars" style="color:' + cat.color + '">' + signalBars(m.rssi) + '</div>' +
                        '<div class="scope-rssi">' + esc(m.rssi) + ' dBm</div>' +
                    '</div>' +
                '</div>';
            }
            list.innerHTML = html;
        }

        // Repaint on a timer so stale rows fade even when no new data arrives.
        setInterval(renderScope, 1500);

        // =====================================================================
        //  Incoming telemetry
        // =====================================================================
        function processIncomingData(dataStr) {
            try {
                const data = JSON.parse(dataStr);
                if (data.targets) {
                    ingestTargets(data.targets);
                    renderScope();
                }
            } catch (e) {
                console.warn('Data parse error:', e);
            }
        }

        // =====================================================================
        //  Opt-in, consented, encrypted location pins (evidence you choose).
        // =====================================================================
        // Default OFF. When ON and a known device is detected, we ask once per
        // device whether to drop a pin. A yes captures ONE location fix (never a
        // continuous track) and stores it as ciphertext behind a PIN.
        const RECORD_PREF_KEY = 'recordEnabled';
        const PIN_STORE_KEY   = 'pinStoreV1';
        let recordEnabled = false;
        let pinKey = null;             // CryptoKey, set once unlocked this session
        let pinSalt = null;            // Uint8Array, persisted with the store
        let pinsCache = [];            // decrypted pins, in memory only while unlocked
        const handledMacs = new Set(); // asked-or-recorded this session (no re-prompt)
        let consentQueue = [];         // pending {match}

        function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
        function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

        async function deriveKey(pin, saltBytes) {
            const enc = new TextEncoder();
            const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
            return crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: saltBytes, iterations: 150000, hash: 'SHA-256' },
                base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        }

        function pinStoreExists() {
            try { return !!localStorage.getItem(PIN_STORE_KEY); } catch (e) { return false; }
        }

        async function savePins() {
            if (!pinKey || !pinSalt) return;
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const enc = new TextEncoder();
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, pinKey,
                enc.encode(JSON.stringify(pinsCache)));
            const payload = { v: 1, salt: b64(pinSalt), iv: b64(iv), ct: b64(ct) };
            try { localStorage.setItem(PIN_STORE_KEY, JSON.stringify(payload)); }
            catch (e) { showToast('Could not save pin', '✕'); }
        }

        // Create a brand-new store with this PIN (first time recording).
        async function createPinStore(pin) {
            pinSalt = crypto.getRandomValues(new Uint8Array(16));
            pinKey = await deriveKey(pin, pinSalt);
            pinsCache = [];
            await savePins();
        }

        // Unlock an existing store. Throws if the PIN is wrong (GCM auth fails).
        async function unlockPins(pin) {
            const raw = JSON.parse(localStorage.getItem(PIN_STORE_KEY));
            const salt = unb64(raw.salt), iv = unb64(raw.iv), ct = unb64(raw.ct);
            const key = await deriveKey(pin, salt);
            const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); // throws on bad PIN
            pinsCache = JSON.parse(new TextDecoder().decode(dec));
            pinKey = key; pinSalt = salt;
        }

        function wipePins() {
            try { localStorage.removeItem(PIN_STORE_KEY); } catch (e) {}
            pinKey = null; pinSalt = null; pinsCache = [];
        }

        // One-shot location (never watchPosition — no passive trail).
        function getFix() {
            return new Promise((resolve, reject) => {
                const ok = (pos) => resolve({
                    lat: pos.coords.latitude, lng: pos.coords.longitude,
                    acc: pos.coords.accuracy
                });
                if (window.Geolocation && window.Geolocation.getCurrentPosition) {
                    window.Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 })
                        .then(ok).catch(reject);
                } else if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(ok, reject, { enableHighAccuracy: true, timeout: 15000 });
                } else {
                    reject(new Error('No geolocation available'));
                }
            });
        }

        // ---- Consent flow ----
        function toggleRecording() {
            recordEnabled = !recordEnabled;
            try { localStorage.setItem(RECORD_PREF_KEY, recordEnabled ? '1' : '0'); } catch (e) {}
            const btn = document.getElementById('btn-record');
            if (btn) {
                btn.classList.toggle('on', recordEnabled);
                btn.textContent = recordEnabled ? '● Recording: ON' : '○ Recording: OFF';
            }
            showToast(recordEnabled ? 'Location recording ON (you will be asked per device)' : 'Location recording OFF', recordEnabled ? '●' : '○');
        }

        function maybeOfferRecord(match) {
            if (!recordEnabled) return;
            if (handledMacs.has(match.mac)) return;
            handledMacs.add(match.mac);
            consentQueue.push(match);
            if (consentQueue.length === 1) showNextConsent();
        }

        function showNextConsent() {
            const m = consentQueue[0];
            if (!m) return;
            const cat = categoryOf(m.type || m.rule);
            document.getElementById('consent-text').innerHTML =
                'Record <strong style="color:' + cat.color + '">' + esc(cat.label) + '</strong> here?<br>' +
                '<span style="color:var(--text-muted); font-size:0.85rem">' + esc(m.name || m.rule || m.mac) + '</span>';
            document.getElementById('consent-modal').classList.add('active');
        }

        function consentDismiss() {
            document.getElementById('consent-modal').classList.remove('active');
            consentQueue.shift();
            if (consentQueue.length) setTimeout(showNextConsent, 300);
        }

        async function consentYes() {
            const m = consentQueue[0];
            document.getElementById('consent-modal').classList.remove('active');
            try {
                const fix = await getFix();
                // Ensure the store is unlocked / created before writing.
                if (!pinKey) {
                    pendingPinAction = async () => { await writePin(m, fix); };
                    openPinGate(pinStoreExists() ? 'unlock' : 'create');
                } else {
                    await writePin(m, fix);
                }
            } catch (e) {
                showToast('No GPS fix — pin not saved', '✕');
            }
            consentQueue.shift();
            if (consentQueue.length) setTimeout(showNextConsent, 300);
        }

        async function writePin(m, fix) {
            const cat = categoryOf(m.type || m.rule);
            pinsCache.push({
                mac: m.mac, category: cat.label, rule: m.rule || '', name: m.name || '',
                rssi: m.rssi, lat: fix.lat, lng: fix.lng, acc: fix.acc, ts: Date.now()
            });
            await savePins();
            showToast('Pin saved (' + pinsCache.length + ' total)', '📍');
        }

        // ---- PIN gate modal ----
        let pendingPinAction = null;   // run after a successful unlock/create
        let pinGateMode = 'unlock';    // 'unlock' | 'create'
        function openPinGate(mode) {
            pinGateMode = mode;
            document.getElementById('pin-input').value = '';
            document.getElementById('pin-gate-title').textContent =
                mode === 'create' ? 'Set a PIN to protect your pins' : 'Enter PIN to unlock pins';
            document.getElementById('pin-error').textContent = '';
            document.getElementById('pin-gate-modal').classList.add('active');
            setTimeout(() => document.getElementById('pin-input').focus(), 100);
        }
        function closePinGate() {
            document.getElementById('pin-gate-modal').classList.remove('active');
            pendingPinAction = null;
        }
        async function submitPin() {
            const pin = document.getElementById('pin-input').value;
            if (!pin || pin.length < 4) {
                document.getElementById('pin-error').textContent = 'Use at least 4 digits/characters.';
                return;
            }
            try {
                if (pinGateMode === 'create') await createPinStore(pin);
                else await unlockPins(pin);
                document.getElementById('pin-gate-modal').classList.remove('active');
                const act = pendingPinAction; pendingPinAction = null;
                if (act) await act();
            } catch (e) {
                document.getElementById('pin-error').textContent = 'Wrong PIN — nothing revealed.';
            }
        }

        // ---- Pins view / export ----
        function openPins() {
            if (!pinStoreExists()) { showToast('No pins recorded yet', 'ℹ'); return; }
            if (!pinKey) { pendingPinAction = renderPins; openPinGate('unlock'); return; }
            renderPins();
        }
        function renderPins() {
            const body = document.getElementById('pins-body');
            if (pinsCache.length === 0) {
                body.innerHTML = '<div class="scope-empty">No pins yet. Turn Recording ON and confirm a device to drop one.</div>';
            } else {
                body.innerHTML = pinsCache.map((p, i) => {
                    const cat = categoryOf(p.category);
                    return '<div class="scope-row" style="border-left:4px solid ' + cat.color + '">' +
                        '<div class="scope-main">' +
                            '<div class="scope-title">' + cat.icon + ' ' + esc(p.category) + '</div>' +
                            '<div class="scope-sub">' + esc(p.mac) + ' · ' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) +
                                ' · ±' + Math.round(p.acc) + 'm · ' + new Date(p.ts).toLocaleString() + '</div>' +
                        '</div>' +
                        '<button class="scope-del" onclick="deletePin(' + i + ')">✕</button>' +
                    '</div>';
                }).join('');
            }
            document.getElementById('pins-modal').classList.add('active');
        }
        async function deletePin(i) {
            pinsCache.splice(i, 1);
            await savePins();
            renderPins();
        }
        function wipePinsConfirm() {
            if (!confirm('Delete ALL recorded pins permanently? This cannot be undone.')) return;
            wipePins();
            document.getElementById('pins-modal').classList.remove('active');
            showToast('All pins wiped', '🗑');
        }

        function xmlAttr(v) { return esc(v); }
        function exportPinsFile() {
            if (pinsCache.length === 0) { showToast('No pins to export', 'ℹ'); return; }
            const blob = new Blob([JSON.stringify(pinsCache, null, 2)], { type: 'application/json' });
            downloadBlob(blob, 'signalsweep-pins-' + Date.now() + '.json');
        }
        // OSM: exporting CAMERA locations is the DeFlock use case, not a movement
        // leak — the pins are devices you consented to mark, never a track of you.
        function exportPinsOSM() {
            if (pinsCache.length === 0) { showToast('No pins to export', 'ℹ'); return; }
            let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="SignalSweep">\n';
            pinsCache.forEach((p, i) => {
                xml += '  <node id="-' + (i + 1) + '" lat="' + p.lat.toFixed(7) + '" lon="' + p.lng.toFixed(7) + '">\n';
                xml += '    <tag k="man_made" v="surveillance"/>\n';
                xml += '    <tag k="surveillance:type" v="camera"/>\n';
                xml += '    <tag k="signalsweep:category" v="' + xmlAttr(p.category) + '"/>\n';
                if (p.mac) xml += '    <tag k="signalsweep:mac" v="' + xmlAttr(p.mac) + '"/>\n';
                xml += '  </node>\n';
            });
            xml += '</osm>\n';
            downloadBlob(new Blob([xml], { type: 'application/xml' }), 'signalsweep-pins-' + Date.now() + '.osm');
        }
        function downloadBlob(blob, name) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast('Exported ' + name, '✓');
        }

        // =====================================================================
        //  Alarm tuning + signature editor (device commands)
        // =====================================================================
        let buzzerOn = true;
        function toggleBuzzer() {
            buzzerOn = !buzzerOn;
            sendCommand({ buzzer: buzzerOn });
            const btn = document.getElementById('btn-buzzer');
            if (btn) {
                btn.classList.toggle('on', buzzerOn);
                btn.textContent = buzzerOn ? '🔊 Buzzer: ON' : '🔇 Buzzer: OFF';
            }
        }

        function openSignatures() {
            document.getElementById('sig-modal').classList.add('active');
        }
        function saveSignatures() {
            const txt = document.getElementById('sig-input').value.trim();
            if (!txt) { showToast('Nothing to send', 'ℹ'); return; }
            let arr;
            try { arr = JSON.parse(txt); } catch (e) { showToast('Invalid JSON', '✕'); return; }
            if (!Array.isArray(arr)) { showToast('Expected a JSON array of rules', '✕'); return; }
            sendCommand({ signatures: arr });
            showToast('Signature rules sent', '✓');
            document.getElementById('sig-modal').classList.remove('active');
        }
        function resetSignatures() {
            if (!confirm('Restore the built-in signature rules on the device?')) return;
            sendCommand({ raw: 'CMD:SIGS:RESET' });
            showToast('Reset to defaults', '✓');
        }

        // =====================================================================
        //  BLE / Serial transport  (preserved from the original app)
        // =====================================================================
        let bleDevice = null;
        let gattServer = null;
        let rxCharacteristic = null;
        let txCharacteristic = null;
        let serialPort = null;
        let serialReader = null;
        let serialWriter = null;
        let rxBuffer = '';

        function checkApiSupport() {
            const bleBadge = document.getElementById('bleSupportBadge');
            const serialBadge = document.getElementById('serialSupportBadge');
            if ('bluetooth' in navigator) {
                bleBadge.className = 'api-badge ok'; bleBadge.textContent = 'Supported';
            } else {
                bleBadge.className = 'api-badge warn'; bleBadge.textContent = 'Not Supported';
            }
            if ('serial' in navigator) {
                serialBadge.className = 'api-badge ok'; serialBadge.textContent = 'Supported';
            } else {
                serialBadge.className = 'api-badge warn'; serialBadge.textContent = 'Not Supported';
            }
        }

        function openConnModal()  { document.getElementById('connModal').classList.add('active'); }
        function closeConnModal() { document.getElementById('connModal').classList.remove('active'); }

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

        // Subscribe to TX notifications for a native BLE device (shared by
        // connect and by reconcileConnection after a resume).
        async function subscribeNative(deviceId) {
            await window.BleClient.startNotifications(
                deviceId, NUS_SERVICE_UUID, NUS_TX_UUID,
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
                const existing = await window.BleClient.getConnectedDevices([NUS_SERVICE_UUID]);
                let device = existing && existing[0];
                if (!device) {
                    device = await window.BleClient.requestDevice({
                        services: [NUS_SERVICE_UUID], optionalServices: [NUS_SERVICE_UUID]
                    });
                    await window.BleClient.connect(device.deviceId, () => onDeviceDisconnected());
                } else {
                    try { await window.BleClient.connect(device.deviceId, () => onDeviceDisconnected()); } catch (e) { /* already connected */ }
                }
                bleDevice = device;
                await subscribeNative(device.deviceId);
                rememberDevice(device.deviceId);
                wantConnection = true;
                reconnectDelay = 0;
                updateConnectionUI(true, 'BLE');
            } catch (err) {
                console.error('Native BLE Connect Failed:', err);
                updateConnectionUI(false);
                showToast(`Native BLE Connect Failed: ${err.message || err}`, '✕');
            }
        }

        async function reconcileConnection() {
            if (!(window.Capacitor && window.Capacitor.isNativePlatform() && window.BleClient)) return;
            try {
                const connected = await window.BleClient.getConnectedDevices([NUS_SERVICE_UUID]);
                const device = connected && connected[0];
                if (device) {
                    if (connectionType !== 'BLE' || !bleDevice) {
                        bleDevice = device;
                        try { await subscribeNative(device.deviceId); } catch (e) { /* already subscribed */ }
                        updateConnectionUI(true, 'BLE');
                    }
                } else if (connectionType === 'BLE') {
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
                    device = await navigator.bluetooth.requestDevice({
                        acceptAllDevices: true, optionalServices: [NUS_SERVICE_UUID]
                    });
                }
                bleDevice = device;
                bleDevice.addEventListener('gattserverdisconnected', onDeviceDisconnected);
                gattServer = await bleDevice.gatt.connect();
                const service = await gattServer.getPrimaryService(NUS_SERVICE_UUID);
                rxCharacteristic = await service.getCharacteristic(NUS_RX_UUID);
                txCharacteristic = await service.getCharacteristic(NUS_TX_UUID);
                await txCharacteristic.startNotifications();
                txCharacteristic.addEventListener('characteristicvaluechanged', handleBleNotification);
                updateConnectionUI(true, 'BLE');
            } catch (err) {
                console.error('Web Bluetooth connection failed:', err);
                updateConnectionUI(false);
                if (err.name !== 'NotFoundError') {
                    showToast(`BLE Connect Failed: ${err.message || err}`, '✕');
                }
            }
        }

        function handleBleNotification(event) {
            const chunk = new TextDecoder('utf-8').decode(event.target.value);
            processIncomingChunk(chunk);
        }

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
                const textDecoder = new TextDecoderStream();
                serialPort.readable.pipeTo(textDecoder.writable);
                serialReader = textDecoder.readable.getReader();
                const textEncoder = new TextEncoderStream();
                textEncoder.readable.pipeTo(serialPort.writable);
                serialWriter = textEncoder.writable.getWriter();
                updateConnectionUI(true, 'SERIAL');
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
                    if (done) break;
                    if (value) processIncomingChunk(value);
                }
            } catch (err) {
                console.error('Serial read loop error:', err);
            } finally {
                onDeviceDisconnected();
            }
        }

        function processIncomingChunk(chunk) {
            rxBuffer += chunk;
            let lines = rxBuffer.split('\n');
            rxBuffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) processIncomingData(trimmed);
            }
        }

        async function sendCommand(cmdObj) {
            const jsonStr = (cmdObj.raw || JSON.stringify(cmdObj)) + '\n';
            if (connectionType === 'BLE') {
                try {
                    const data = new TextEncoder().encode(jsonStr);
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
                try { await serialWriter.write(jsonStr); return true; }
                catch (err) {
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
            cancelReconnect();
            if (bleDevice) {
                if (bleDevice.gatt && bleDevice.gatt.connected) {
                    bleDevice.gatt.disconnect();
                } else if (window.BleClient && bleDevice.deviceId) {
                    try { await window.BleClient.disconnect(bleDevice.deviceId); } catch (e) { console.error(e); }
                }
            }
            if (serialReader) { try { await serialReader.cancel(); } catch (e) {} serialReader = null; }
            if (serialWriter) { try { await serialWriter.close(); } catch (e) {} serialWriter = null; }
            if (serialPort)   { try { await serialPort.close(); } catch (e) {} serialPort = null; }
            onDeviceDisconnected();
        }

        // ---- Auto-reconnect (BLE only) ----
        const LAST_DEVICE_KEY = 'lastBleDeviceId';
        let wantConnection = false;
        let reconnectTimer = null;
        let reconnectDelay = 0;

        function rememberDevice(deviceId) {
            if (!deviceId) return;
            try { localStorage.setItem(LAST_DEVICE_KEY, deviceId); } catch (e) {}
        }
        function cancelReconnect() {
            wantConnection = false;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            reconnectDelay = 0;
        }
        function scheduleReconnect() {
            if (!wantConnection || reconnectTimer) return;
            reconnectDelay = Math.min(reconnectDelay ? reconnectDelay * 2 : 2000, 30000);
            const secs = Math.round(reconnectDelay / 1000);
            const el = document.getElementById('connStatusText');
            if (el) el.textContent = 'RECONNECTING (' + secs + 's)...';
            reconnectTimer = setTimeout(async () => {
                reconnectTimer = null;
                if (!wantConnection) return;
                const ok = await tryReconnect();
                if (!ok) scheduleReconnect();
            }, reconnectDelay);
        }
        async function tryReconnect() {
            try {
                if (window.Capacitor && window.Capacitor.isNativePlatform() && window.BleClient) {
                    let id = null;
                    try {
                        const existing = await window.BleClient.getConnectedDevices([NUS_SERVICE_UUID]);
                        if (existing && existing[0]) id = existing[0].deviceId;
                    } catch (e) {}
                    if (!id) { try { id = localStorage.getItem(LAST_DEVICE_KEY); } catch (e) {} }
                    if (!id) return false;
                    await window.BleClient.connect(id, () => onDeviceDisconnected());
                    await subscribeNative(id);
                    bleDevice = { deviceId: id };
                    updateConnectionUI(true, 'BLE');
                    reconnectDelay = 0;
                    showToast('Reconnected', '✓');
                    return true;
                }
            } catch (e) {
                console.warn('reconnect attempt failed', e);
            }
            return false;
        }
        function onDeviceDisconnected() {
            bleDevice = null; gattServer = null; rxCharacteristic = null; txCharacteristic = null;
            serialPort = null; serialReader = null; serialWriter = null;
            updateConnectionUI(false);
            if (wantConnection) scheduleReconnect();
        }

        function showToast(msg, icon = '✓') {
            const toast = document.getElementById('toast');
            const toastMsg = document.getElementById('toast-msg');
            const toastIcon = document.getElementById('toast-icon');
            if (toast && toastMsg && toastIcon) {
                toastMsg.textContent = msg;
                toastIcon.textContent = icon;
                toast.classList.add('show');
                setTimeout(() => toast.classList.remove('show'), 3000);
            }
        }

        // Re-sync on foreground so a background/resume can't strand the UI.
        if (window.App) {
            window.App.addListener('appStateChange', (state) => {
                if (state && state.isActive) reconcileConnection();
            });
        }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reconcileConnection();
        });

        document.addEventListener('DOMContentLoaded', () => {
            // Restore only the recording toggle (a preference, not a trail).
            try { recordEnabled = localStorage.getItem(RECORD_PREF_KEY) === '1'; } catch (e) {}
            const rb = document.getElementById('btn-record');
            if (rb) { rb.classList.toggle('on', recordEnabled); rb.textContent = recordEnabled ? '● Recording: ON' : '○ Recording: OFF'; }

            checkApiSupport();
            renderScope();
            setTimeout(async () => {
                await reconcileConnection();
                if (!connectionType) openConnModal();
            }, 600);

            setTimeout(() => {
                if (window.App) {
                    window.App.addListener('backButton', () => window.App.exitApp());
                }
            }, 1000);
        });

        // ---- Self-test hook (see selftest.js) ----
        // Exposed so node can exercise the crypto round-trip and category map
        // without a browser. Guarded because window === global under node.
        if (typeof window !== 'undefined') {
            window.__signalsweepSelfTest = async function () {
                const results = {};
                // Category routing
                results.catDrone   = categoryOf('Remote ID Drone').key === 'drone';
                results.catTracker = categoryOf('Apple Find My Tracker').key === 'tracker';
                results.catBodycam = categoryOf('Axon').key === 'bodycam';
                results.catAlpr    = categoryOf('Flock Safety').key === 'alpr';
                // Crypto round-trip: create → save → reload → unlock
                await createPinStore('1234');
                pinsCache.push({ mac: 'AA:BB', category: 'ALPR / Camera', lat: 30.2, lng: -92.0, acc: 5, ts: 1 });
                await savePins();
                pinKey = null; pinsCache = [];
                await unlockPins('1234');
                results.cryptoRoundTrip = pinsCache.length === 1 && pinsCache[0].mac === 'AA:BB';
                // Wrong PIN reveals nothing
                pinKey = null; pinsCache = [];
                let wrongFailed = false;
                try { await unlockPins('9999'); } catch (e) { wrongFailed = true; }
                results.wrongPinRejected = wrongFailed && pinsCache.length === 0;
                return results;
            };
        }
