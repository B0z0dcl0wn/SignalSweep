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
            // Nothing matched. This is its own state, not a weak match: with
            // the filter off most of the list is ordinary hardware, and folding
            // it into the generic bucket titled every unnamed phone "Match"
            // behind a warning triangle, then counted it under Cameras.
            if (!c) return { key: 'none', label: '', color: '#3a465a', icon: '' };
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
                    protocol: t.protocol || 'BLE', ssid: t.ssid || '',
                    confidence: t.confidence || 0,
                    tier: t.tier || '', ts: now,
                    // Decoded ASTM Remote ID, present only on drones. The
                    // firmware omits any field it does not actually know, so
                    // undefined here means "unknown", never "zero".
                    uasId: t.uas_id, operatorId: t.operator_id, selfId: t.self_id,
                    lat: t.lat, lng: t.lng, alt: t.alt, agl: t.agl,
                    speed: t.speed, heading: t.heading,
                    opLat: t.op_lat, opLng: t.op_lng
                };
                maybeOfferRecord(liveMatches[t.mac]);
            }
        }

        // ---- Lens: a filter over what the detector already found -----------
        // This is what replaces the old four-mode selector, and the important
        // difference is that it changes nothing on the device. The firmware is
        // one always-on detector watching every category at once; switching
        // lens sends no command and cannot make it miss anything. (The old
        // build's modes were largely one detector wearing different filters --
        // this is that idea, minus the state machine.)
        let lens = 'all';
        let viewMode = 'list';   // 'list' | 'map'

        function setLens(key) {
            lens = key;
            document.querySelectorAll('#bands .band').forEach(function (el) {
                el.setAttribute('aria-selected',
                    el.getAttribute('data-lens') === key ? 'true' : 'false');
            });
            renderScope();
        }

        function toggleView() {
            viewMode = (viewMode === 'list') ? 'map' : 'list';
            const wrap = document.getElementById('map-wrap');
            const list = document.getElementById('targets-list');
            const btn  = document.getElementById('btn-view');
            if (wrap) wrap.style.display = (viewMode === 'map') ? 'block' : 'none';
            if (list) list.style.display = (viewMode === 'map') ? 'none' : 'block';
            if (btn)  btn.textContent = (viewMode === 'map') ? '\u2630 List' : '\ud83d\uddfa Map';
            if (viewMode === 'map') initMap();
            renderScope();
        }

        // Which band a row belongs in.
        //
        // Three distinct states, and conflating them was putting ordinary
        // hardware under "Cameras":
        //   * no type and no rule      -> matched nothing at all
        //   * a rule but no type       -> matched something the firmware
        //                                 deliberately refuses to attribute,
        //                                 i.e. the Lite-On vendor IE, which is
        //                                 in countless consumer Wi-Fi chips.
        //                                 Real example: Nest cameras listed as
        //                                 "Cameras" off a prefix that only
        //                                 means "this chipset".
        //   * a type                   -> a real vendor category
        // Only the last belongs in a category band.
        function bandOf(m) {
            if (!m.type && !m.rule) return 'none';
            if (!m.type) return 'weak';
            return categoryOf(m.type).key;
        }

        // Radio filter. When you are looking for one kind of thing, the other
        // radio's devices are noise -- and with the filter off most of the list
        // is Wi-Fi access points.
        let radio = 'any';   // 'any' | 'BLE' | 'WiFi'

        function setRadio(key) {
            radio = key;
            document.querySelectorAll('#radios .radio-tab').forEach(function (el) {
                el.setAttribute('aria-selected',
                    el.getAttribute('data-radio') === key ? 'true' : 'false');
            });
            renderScope();
        }

        // A device seen on both radios counts as either.
        function matchesRadio(m) {
            if (radio === 'any') return true;
            return String(m.protocol || '').indexOf(radio) >= 0;
        }

        // Live rows: heard recently, matching the current lens, strongest first.
        function liveRows(forLens) {
            const now = Date.now();
            const k = forLens || lens;
            return Object.values(liveMatches)
                .filter(function (m) { return now - m.ts < LIVE_STALE_MS; })
                .filter(matchesRadio)
                .filter(function (m) {
                    if (k === 'all') return true;
                    const c = bandOf(m);
                    // "Surveillance" is the umbrella over what the buzzer says
                    // as two separate words (ALPR and body cam), plus a vendor
                    // category we have no keyword for (SoundThinking, Raven).
                    // It does NOT include 'weak' -- see bandOf().
                    if (k === 'alpr') return c === 'alpr' || c === 'bodycam' || c === 'other';
                    return c === k;
                })
                .sort(function (a, b) { return (b.rssi || -999) - (a.rssi || -999); });
        }

        // One line of extra detail per category. Drones earn the most, because
        // Remote ID is a broadcast standard that hands us real values.
        function detailLine(m, cat) {
            const bits = [];
            if (cat.key === 'drone') {
                if (m.uasId)      bits.push('UAS <b>' + esc(m.uasId) + '</b>');
                if (m.operatorId) bits.push('Operator <b>' + esc(m.operatorId) + '</b>');
                if (m.selfId)     bits.push(esc(m.selfId));
                if (m.alt   != null) bits.push('Alt <b>' + Math.round(m.alt) + ' m</b>');
                if (m.agl   != null) bits.push('AGL <b>' + Math.round(m.agl) + ' m</b>');
                if (m.speed != null) bits.push('<b>' + Number(m.speed).toFixed(1) + ' m/s</b>');
                if (m.heading != null) bits.push('Hdg <b>' + Math.round(m.heading) + '\u00b0</b>');
                if (m.lat != null && m.lng != null)
                    bits.push('at <b>' + Number(m.lat).toFixed(5) + ', ' + Number(m.lng).toFixed(5) + '</b>');
                if (m.opLat != null && m.opLng != null)
                    bits.push('pilot at <b>' + Number(m.opLat).toFixed(5) + ', ' + Number(m.opLng).toFixed(5) + '</b>');
            }
            if (!bits.length) return '';
            return '<div class="scope-detail">' + bits.join(' \u00b7 ') + '</div>';
        }

        // Trackers get the two things you actually want when something may be
        // following you: walk it down, or make it announce itself.
        function actionRow(m, cat) {
            // Trackers always offer it. With the filter off, anything does --
            // that is the whole point of turning the filter off: find something
            // interesting that is on no list, then go and physically find it.
            if (cat.key !== 'tracker' && !foxhuntMode) return '';
            const hunting = !!huntMac && huntMac.toUpperCase() === String(m.mac).toUpperCase();
            // Ring is a GATT write to a Bluetooth characteristic. On a device
            // only ever heard over Wi-Fi there is nothing to connect to, so the
            // button would be a guaranteed failure dressed up as an option.
            const hasBle = String(m.protocol || '').indexOf('BLE') >= 0;
            return '<div class="scope-actions">' +
                '<button class="scope-act' + (hunting ? ' hunting' : '') +
                    '" data-act="hunt" data-mac="' + esc(m.mac) + '">' +
                    (hunting ? '\u25c9 Hunting \u2014 stop' : '\u25ce Hunt') + '</button>' +
                (hasBle
                    ? '<button class="scope-act" data-act="ring" data-mac="' + esc(m.mac) + '">\ud83d\udd14 Ring</button>'
                    : '') +
            '</div>';
        }

        // Map RSSI to a 0-1 meter fill. -95 dBm is the noise floor in practice,
        // -35 is "in the same room"; anything outside that is clamped.
        function rssiFrac(rssi) {
            const r = Number(rssi);
            if (!isFinite(r)) return 0;
            return Math.max(0, Math.min(1, (r + 95) / 60));
        }

        function renderScope() {
            // Each band shows its own count and the strongest signal in it right
            // now, whether or not it is the selected band. That is the point of
            // the strip: you can be reading Drones and still see that something
            // just got loud in Trackers.
            const keys = ['all', 'alpr', 'tracker', 'drone'];
            for (let i = 0; i < keys.length; i++) {
                const bandRows = liveRows(keys[i]);
                const el = document.getElementById('n-' + keys[i]);
                if (el) el.textContent = bandRows.length;
                const meter = document.getElementById('m-' + keys[i]);
                const strongest = bandRows.length
                    ? Math.max.apply(null, bandRows.map(function (m) { return Number(m.rssi) || -999; }))
                    : null;
                if (meter) meter.style.width = (strongest == null ? 0 : rssiFrac(strongest) * 100) + '%';
                const tab = document.querySelector('#bands .band[data-lens="' + keys[i] + '"]');
                if (tab) tab.classList.toggle('live', bandRows.length > 0);
            }
            // The foxhunt panel draws to a canvas and touches elements that may
            // not exist in every context. It must never be able to take the
            // device list down with it -- the list is the part you actually
            // need on screen.
            try { renderFoxhunt(); } catch (e) { console.warn('foxhunt render failed:', e); }

            const rows = liveRows();
            const countEl = document.getElementById('scope-count');
            if (countEl) countEl.textContent = rows.length;
            const dropEl = document.getElementById('scope-drop');
            if (dropEl) {
                // Only worth showing when a real fraction is being lost; the odd
                // dropped push is normal and not worth alarming anyone about.
                const total = rxOk + rxDropped;
                const bad = total > 10 && rxDropped / total > 0.1;
                dropEl.style.display = bad ? 'inline' : 'none';
                if (bad) dropEl.textContent = Math.round(100 * rxDropped / total) + '% of updates lost';
            }

            if (viewMode === 'map') { renderMap(rows); return; }

            const list = document.getElementById('targets-list');
            if (!list) return;

            if (rows.length === 0) {
                list.innerHTML = '<div class="scope-empty">' +
                    (connectionType ? 'Listening\u2026 nothing matched right now. If the buzzer sounds, look around.'
                                    : 'Connect the device to see live matches. It still beeps on its own without the phone.') +
                    '</div>';
                return;
            }

            let html = '';
            for (const m of rows) {
                const cat = categoryOf(m.type || m.rule);
                // Name it by whatever a person would recognise: its own name,
                // then the network it is announcing, then the rule it tripped,
                // then its address. Never invent a word for it.
                const title = m.name || m.ssid || m.rule || cat.label || m.mac;
                // With the filter off the list contains devices that matched
                // nothing. Saying so is the difference between a tool and a
                // scaremonger: a listed device is not a detection.
                const band = bandOf(m);
                const unmatched = band === 'none';
                const weak = band === 'weak';
                html += '<div class="scope-row' + (unmatched ? ' unmatched' : '') +
                        '" style="border-left:4px solid ' + cat.color + '">' +
                    '<div class="scope-main">' +
                        '<div class="scope-title">' + (cat.icon ? cat.icon + ' ' : '') + esc(title) +
                            // A weak hint has no vendor to name -- cat.label is
                            // just the rule text, which already appears below.
                            (unmatched || weak ? '' :
                                ' <span class="scope-cat" style="color:' + cat.color + '">' + esc(cat.label) + '</span>') +
                            (unmatched ? '<span class="unmatched-tag">no match</span>' : '') +
                            (weak ? '<span class="unmatched-tag">weak hint</span>' : '') +
                            (m.tier && !unmatched && !weak ? '<span class="tier-badge" style="color:' + cat.color + '">' + esc(m.tier) + '</span>' : '') +
                        '</div>' +
                        // Don't print the address twice when it is also the title.
                        '<div class="scope-sub">' +
                            (title === m.mac ? '' : '<span class="mono">' + esc(m.mac) + '</span> \u00b7 ') +
                            esc(m.protocol) +
                            (m.ssid && m.ssid !== title ? ' \u00b7 ' + esc(m.ssid) : '') +
                            (m.rule ? ' \u00b7 ' + esc(m.rule) : '') +
                            (unmatched ? '' : ' \u00b7 conf ' + (m.confidence | 0)) + '</div>' +
                    '</div>' +
                    '<div class="scope-signal">' +
                        '<div class="scope-bars" style="color:' + cat.color + '">' + signalBars(m.rssi) + '</div>' +
                        '<div class="scope-rssi mono">' + esc(m.rssi) + ' dBm</div>' +
                    '</div>' +
                    detailLine(m, cat) +
                    actionRow(m, cat) +
                '</div>';
            }
            list.innerHTML = html;
        }

        // ---- Hunt / Ring ----------------------------------------------------
        // Hunt is the one thing the app can change about firmware behaviour: the
        // device's buzzer becomes an RSSI-driven Geiger clicker for that MAC so
        // you can physically walk it down. Detection never stops meanwhile.
        let huntMac = '';
        let foxhuntMode = false;      // filter off: list everything, hunt anything
        // Signal strength for the locked target over the last ~40 samples. In
        // memory, cleared when the hunt stops or the link drops. It is a signal
        // trace, not a track -- there is no position in it.
        let huntTrace = [];
        const HUNT_TRACE_MAX = 40;

        function currentHuntMac() { return huntMac; }

        function toggleFoxhunt() {
            foxhuntMode = !foxhuntMode;
            // Listing only. The buzzer stays gated by the firmware's alert
            // threshold either way, so turning the filter off shows you every
            // phone in the room without beeping at a single one.
            sendCommand({ scan_all: foxhuntMode });
            const btn = document.getElementById('btn-foxhunt');
            if (btn) {
                btn.classList.toggle('on', foxhuntMode);
                btn.textContent = foxhuntMode ? '\u25c9 Filter: off' : '\u25ce Filter: matches';
            }
            const radios = document.getElementById('radios');
            if (radios) radios.style.display = foxhuntMode ? 'grid' : 'none';
            if (!foxhuntMode) setRadio('any');
            if (!foxhuntMode && huntMac) stopHunt();
            showToast(foxhuntMode ? 'Showing everything the radios hear'
                                  : 'Showing signature matches only',
                      foxhuntMode ? '\u25c9' : '\u25ce');
            renderScope();
        }

        function huntTarget(mac) {
            const same = huntMac && huntMac.toUpperCase() === String(mac).toUpperCase();
            if (same) { stopHunt(); return; }
            huntMac = String(mac);
            huntTrace = [];
            sendCommand({ hunt: huntMac });
            showToast('Locked on \u2014 the device is clicking now', '\u25c9');
            renderScope();
        }

        function stopHunt() {
            huntMac = '';
            huntTrace = [];
            sendCommand({ hunt: '' });   // "" clears; see ble_serial.cpp
            showToast('Hunt stopped', '\u25cb');
            renderScope();
        }

        // The foxhunt instrument. Big enough to read at arm's length, because
        // you are meant to be walking and listening to the device, not staring
        // at the phone.
        function renderFoxhunt() {
            const panel = document.getElementById('fox');
            if (!panel) return;
            if (!huntMac) { panel.style.display = 'none'; return; }
            panel.style.display = 'block';

            const m = liveMatches[huntMac] ||
                      liveMatches[Object.keys(liveMatches).find(function (k) {
                          return k.toUpperCase() === huntMac.toUpperCase();
                      })];

            const nameEl  = document.getElementById('fox-name');
            const macEl   = document.getElementById('fox-mac');
            const rssiEl  = document.getElementById('fox-rssi');
            const trendEl = document.getElementById('fox-trend');
            if (macEl) macEl.textContent = huntMac;

            if (!m) {
                if (nameEl)  nameEl.textContent = 'Lost signal';
                if (rssiEl)  rssiEl.textContent = '--';
                if (trendEl) { trendEl.textContent = 'no signal'; trendEl.style.color = 'var(--ss-dim)'; }
                drawTrace();
                return;
            }

            const cat = categoryOf(m.type || m.rule);
            if (nameEl) nameEl.textContent = m.name || m.rule || cat.label;
            if (rssiEl) rssiEl.textContent = m.rssi;

            // Only append when the device actually reported again, so standing
            // still doesn't fill the trace with duplicates of one sample.
            const last = huntTrace.length ? huntTrace[huntTrace.length - 1] : null;
            if (!last || last.ts !== m.ts) {
                huntTrace.push({ rssi: Number(m.rssi), ts: m.ts });
                if (huntTrace.length > HUNT_TRACE_MAX) huntTrace.shift();
            }

            // Warmer/colder from the last handful of samples against the ones
            // before them. 3 dB is roughly the smallest change worth acting on;
            // below that the reading is just multipath noise.
            if (trendEl) {
                const t = huntTrace.map(function (p) { return p.rssi; });
                if (t.length < 6) {
                    trendEl.textContent = 'reading\u2026';
                    trendEl.style.color = 'var(--ss-dim)';
                } else {
                    const avg = (a) => a.reduce(function (x, y) { return x + y; }, 0) / a.length;
                    const delta = avg(t.slice(-4)) - avg(t.slice(-10, -4));
                    if (delta > 3)       { trendEl.textContent = 'warmer';  trendEl.style.color = 'var(--ss-live)'; }
                    else if (delta < -3) { trendEl.textContent = 'colder';  trendEl.style.color = 'var(--accent-amber)'; }
                    else                 { trendEl.textContent = 'holding'; trendEl.style.color = 'var(--ss-dim)'; }
                }
            }
            drawTrace();
        }

        function drawTrace() {
            const cv = document.getElementById('fox-trace');
            if (!cv || !cv.getContext) return;
            const dpr = window.devicePixelRatio || 1;
            const w = cv.clientWidth, h = cv.clientHeight;
            if (!w || !h) return;
            if (cv.width !== w * dpr || cv.height !== h * dpr) {
                cv.width = w * dpr; cv.height = h * dpr;
            }
            const ctx = cv.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            // Baseline so an empty trace still reads as an instrument at rest
            // rather than a broken element.
            ctx.strokeStyle = 'rgba(140,170,210,0.18)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
            if (huntTrace.length < 2) return;

            const step = w / (HUNT_TRACE_MAX - 1);
            const y = (r) => h - 2 - rssiFrac(r) * (h - 4);
            const x0 = w - (huntTrace.length - 1) * step;

            ctx.beginPath();
            huntTrace.forEach(function (p, i) {
                const x = x0 + i * step;
                if (i === 0) ctx.moveTo(x, y(p.rssi)); else ctx.lineTo(x, y(p.rssi));
            });
            ctx.strokeStyle = '#ff3ac8';
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.stroke();

            ctx.lineTo(x0 + (huntTrace.length - 1) * step, h);
            ctx.lineTo(x0, h);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255,58,200,0.14)';
            ctx.fill();
        }

        function ringTarget(mac) {
            sendCommand({ ring: String(mac) });
            showToast('Ring sent \u2014 listen for it', '\ud83d\udd14');
        }

        // Delegated, because a MAC is device-supplied text and must never be
        // interpolated into an onclick string.
        document.addEventListener('click', function (ev) {
            if (!ev.target || !ev.target.closest) return;
            // Must match the band-strip markup in index.html. This selector
            // was left pointing at the old '#lens-row .lens-tab' when the tabs
            // were rebuilt as '#bands .band', which silently made every tab
            // dead: no error, no visual difference, just nothing happening.
            const tab = ev.target.closest('#bands .band');
            if (tab) { setLens(tab.getAttribute('data-lens')); return; }
            const rt = ev.target.closest('#radios .radio-tab');
            if (rt) { setRadio(rt.getAttribute('data-radio')); return; }
            const act = ev.target.closest('.scope-act');
            if (!act) return;
            const mac = act.getAttribute('data-mac');
            if (act.getAttribute('data-act') === 'hunt') huntTarget(mac);
            else if (act.getAttribute('data-act') === 'ring') ringTarget(mac);
        });

        // =====================================================================
        //  Live map. Live ONLY.
        // =====================================================================
        // The map came back; the trail it used to come with did not. Rules that
        // hold here, and the reason each one exists:
        //
        //   * ONE-SHOT position only (getFix), never watchPosition. A passive
        //     position watch is a location history in RAM, and a location
        //     history is the thing this whole redesign exists to not have.
        //   * No breadcrumb polyline. Same reason.
        //   * No offline tile cache. Cached tiles persist on disk and record
        //     which areas you downloaded -- a weak trail, but a real one.
        //   * Nothing here is written to storage, and it all clears on
        //     disconnect along with liveMatches.
        //
        // What gets drawn:
        //   * You: a small dot at your last fix.
        //   * Drones: a solid marker at their DECODED coordinate. That number is
        //     real -- the aircraft broadcast it.
        //   * Everything else: a dashed circle of RSSI-estimated radius around
        //     YOU. Deliberately not a marker, because we do not know where the
        //     thing is; we only know roughly how far. A pin would be a lie.
        //   * Saved pins: only once unlocked. Detecting never asks for the PIN.
        let map = null, meLayer = null, liveLayer = null, pinLayer = null;
        let mapFix = null;   // {lat, lng, acc} -- last one-shot fix, memory only

        // Very rough log-distance path loss. Good enough to say "close" vs "far"
        // and nothing more, which is exactly what the dashed ring claims.
        // ponytail: fixed exponent; add a calibration knob if it reads badly in
        // the field, since real environments vary far more than this model does.
        function rssiMeters(rssi) {
            const r = Number(rssi);
            if (!isFinite(r)) return 100;
            const m = Math.pow(10, (-59 - r) / 20);
            return Math.max(5, Math.min(400, m * 10));
        }

        function initMap() {
            if (map || !window.L) return;
            const el = document.getElementById('map');
            if (!el) return;
            map = window.L.map(el, { zoomControl: true, attributionControl: true })
                    .setView([0, 0], 2);
            // Standard OSM tiles, darkened in CSS rather than a ready-made dark
            // basemap: CARTO's dark_all now returns "API KEY REQUIRED" stamped
            // across every tile, and a detector should not depend on a keyed
            // service to draw a map at all.
            window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors'
            }).addTo(map);
            meLayer   = window.L.layerGroup().addTo(map);
            liveLayer = window.L.layerGroup().addTo(map);
            pinLayer  = window.L.layerGroup().addTo(map);
            recenterMap();
        }

        async function recenterMap() {
            try {
                const fix = await getFix();
                mapFix = { lat: fix.lat, lng: fix.lng, acc: fix.acc };
                if (map) map.setView([mapFix.lat, mapFix.lng], 16);
                renderScope();
            } catch (e) {
                showToast('No location fix available', '!');
            }
        }

        function renderMap(rows) {
            if (!map || !window.L) return;
            meLayer.clearLayers();
            liveLayer.clearLayers();

            if (mapFix) {
                window.L.circleMarker([mapFix.lat, mapFix.lng], {
                    radius: 6, color: '#34d399', fillColor: '#34d399', fillOpacity: 0.9, weight: 2
                }).addTo(meLayer).bindPopup('You');
                if (mapFix.acc) {
                    window.L.circle([mapFix.lat, mapFix.lng], {
                        radius: mapFix.acc, color: '#34d399', weight: 1, opacity: 0.3, fill: false
                    }).addTo(meLayer);
                }
            }

            let ringed = 0;
            for (const m of rows) {
                const cat = categoryOf(m.type || m.rule);
                const title = esc(m.name || m.rule || cat.label);
                if (m.lat != null && m.lng != null) {
                    // A real, broadcast coordinate: it gets a real marker.
                    window.L.circleMarker([m.lat, m.lng], {
                        radius: 8, color: cat.color, fillColor: cat.color, fillOpacity: 0.85, weight: 2
                    }).addTo(liveLayer).bindPopup(cat.icon + ' ' + title + '<br>' + esc(m.mac));
                    if (m.opLat != null && m.opLng != null) {
                        window.L.circleMarker([m.opLat, m.opLng], {
                            radius: 6, color: cat.color, fillColor: '#000', fillOpacity: 0.6, weight: 2
                        }).addTo(liveLayer).bindPopup('Operator of ' + title);
                    }
                } else if (mapFix) {
                    // Distance only. Dashed, unfilled, centred on you -- it must
                    // never read as "the thing is here".
                    window.L.circle([mapFix.lat, mapFix.lng], {
                        radius: rssiMeters(m.rssi), color: cat.color, weight: 1.5,
                        dashArray: '6 6', fill: false, opacity: 0.8
                    }).addTo(liveLayer).bindPopup(cat.icon + ' ' + title + '<br>' + esc(m.mac) +
                        '<br>within ~' + Math.round(rssiMeters(m.rssi)) + ' m (signal strength only)');
                    ringed++;
                }
            }

            renderMapPins();

            const note = document.getElementById('map-note');
            if (note) {
                note.innerHTML = (mapFix ? '' : 'No fix yet. ') +
                    'Solid markers are broadcast coordinates (drones). ' +
                    'Dashed rings are distance-from-you estimates from signal strength \u2014 ' +
                    'not locations. ' + (ringed ? ringed + ' ring(s). ' : '') +
                    '<button class="scope-act" style="margin-left:6px" onclick="recenterMap()">\u27f3 Recenter</button>' +
                    (pinsCache.length ? '' : ' <span style="opacity:0.7">Saved pins appear once unlocked.</span>');
            }
        }

        // Saved pins are drawn only when the store is already unlocked in this
        // session. Opening the map must never prompt for the PIN -- the PIN
        // gates viewing and export, and nothing else.
        function renderMapPins() {
            if (!pinLayer || !window.L) return;
            pinLayer.clearLayers();
            if (!pinKey) return;
            for (const pin of pinsCache) {
                if (pin.lat == null || pin.lng == null) continue;
                const cat = categoryOf(pin.category || pin.rule);
                window.L.marker([pin.lat, pin.lng]).addTo(pinLayer)
                    .bindPopup('\ud83d\udccd ' + esc(pin.name || pin.rule || cat.label) +
                               '<br>' + esc(pin.mac) +
                               '<br>' + esc(new Date(pin.ts).toLocaleString()));
            }
        }

        // Repaint on a timer so stale rows fade even when no new data arrives.
        setInterval(renderScope, 1500);
        // Paint the resting state immediately: an unpainted status strip looks
        // like a hung app, and the resting state ("nothing connected, location
        // off, not recording") is the honest answer on first load.
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('DOMContentLoaded', function () {
                renderStatusStrip();
                renderScope();
            });
        }

        // =====================================================================
        //  Incoming telemetry
        // =====================================================================
        // BLE notifications are unacknowledged, and a telemetry push is split
        // across many of them. Lose one chunk and the reassembled line is
        // truncated JSON, so the whole second's data is discarded -- which looks
        // exactly like "the device found nothing". Count it and show it, rather
        // than logging to a console nobody has open on a phone.
        let rxDropped = 0;
        let rxOk = 0;

        function processIncomingData(dataStr) {
            try {
                const data = JSON.parse(dataStr);
                rxOk++;
                if (data.targets) {
                    ingestTargets(data.targets);
                    renderScope();
                }
                if (data.cfg) {
                    applyConfigToSettings(data);
                    // A board that has been running headless may already be
                    // hunting something or have its filter off. Adopt that on
                    // connect rather than waiting for the first push.
                    syncDeviceState(data);
                }
                // The device is the authority on its own state. After a
                // reconnect the app may believe it is hunting something the
                // board has long since forgotten (it does not persist either
                // flag across a reboot), so take what the telemetry says.
                if ('targets' in data) syncDeviceState(data);
            } catch (e) {
                rxDropped++;
                console.warn('Data parse error (dropped ' + rxDropped + ' of ' +
                             (rxDropped + rxOk) + '):', e);
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

        // ---- Location status ------------------------------------------------
        // A fix vaguer than this is worse than no fix: a pin is evidence of
        // where a camera is, and one saved at plus-or-minus 200 m points at the
        // wrong building. The old build discarded such fixes silently, so a
        // whole drive could record nothing while looking healthy. Show it.
        const FIX_ACCURACY_MAX_M = 50;

        // Deliberately NOT a live GPS state: there is no watchPosition here, so
        // this reports the last one-shot fix and nothing more. "Off" genuinely
        // means nothing has asked for location yet, which is the resting state.
        let gpsState = { state: 'off', acc: null };

        function setGpsState(state, acc) {
            gpsState = { state: state, acc: (acc == null ? null : acc) };
            renderStatusStrip();
        }

        function gpsDisplay() {
            switch (gpsState.state) {
                case 'locating': return { dot: 'warn', text: 'Locating\u2026' };
                case 'denied':   return { dot: 'bad',  text: 'Permission denied' };
                case 'failed':   return { dot: 'bad',  text: 'No fix' };
                case 'fix': {
                    const a = Math.round(gpsState.acc);
                    return (gpsState.acc <= FIX_ACCURACY_MAX_M)
                        ? { dot: 'ok',   text: '\u00b1' + a + ' m' }
                        : { dot: 'warn', text: '\u00b1' + a + ' m \u2014 too vague to pin' };
                }
                default: return { dot: 'off', text: 'Off' };
            }
        }

        function renderStatusStrip() {
            const set = (dotId, textId, cls, text) => {
                const d = document.getElementById(dotId);
                const t = document.getElementById(textId);
                if (d) d.className = 'statdot ' + cls;
                if (t) t.textContent = text;
            };
            set('st-dev-dot', 'st-dev',
                connectionType ? 'ok' : 'off',
                connectionType ? 'Connected' : 'Not connected');
            const g = gpsDisplay();
            set('st-gps-dot', 'st-gps', g.dot, g.text);
            set('st-rec-dot', 'st-rec',
                recordEnabled ? 'ok' : 'off',
                recordEnabled ? 'On' : 'Off');
        }

        // One-shot location (never watchPosition — no passive trail).
        function getFix() {
            return new Promise((resolve, reject) => {
                const ok = (pos) => resolve({
                    lat: pos.coords.latitude, lng: pos.coords.longitude,
                    acc: pos.coords.accuracy
                });
                setGpsState('locating');
                const done = (pos) => { setGpsState('fix', pos.coords.accuracy); ok(pos); };
                const failed = (err) => {
                    // A refused permission and a cold lock that timed out need
                    // opposite responses: one is a settings problem, the other
                    // is worth standing still outside for another few seconds.
                    const denied = err && (err.code === 1 ||
                        /denied|permission/i.test(err.message || ''));
                    setGpsState(denied ? 'denied' : 'failed');
                    reject(err);
                };
                if (window.Geolocation && window.Geolocation.getCurrentPosition) {
                    window.Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 })
                        .then(done).catch(failed);
                } else if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(done, failed, { enableHighAccuracy: true, timeout: 15000 });
                } else {
                    setGpsState('failed');
                    reject(new Error('No geolocation available'));
                }
            });
        }

        // ---- Consent flow ----
        function toggleRecording() {
            recordEnabled = !recordEnabled;
            setTimeout(renderStatusStrip, 0);
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
            // With the filter off the device reports everything it hears, and
            // without this the app would ask permission to pin every phone on
            // the street. Pins are for things that actually matched.
            if (!match.type && !match.rule) return;
            if (handledMacs.has(match.mac)) return;
            handledMacs.add(match.mac);
            consentQueue.push(match);
            if (consentQueue.length === 1) showNextConsent();
        }

        function showNextConsent() {
            const m = consentQueue[0];
            if (!m) return;
            // Called from inside the ingest loop, so a missing element must not
            // throw: that would abandon the rest of the telemetry batch and
            // leave the live list half-populated.
            const textEl = document.getElementById('consent-text');
            if (!textEl) return;
            const cat = categoryOf(m.type || m.rule);
            textEl.innerHTML =
                'Record <strong style="color:' + cat.color + '">' + esc(cat.label) + '</strong> here?<br>' +
                '<span style="color:var(--text-muted); font-size:0.85rem">' + esc(m.name || m.rule || m.mac) + '</span>';
            const modal = document.getElementById('consent-modal');
            if (modal) modal.classList.add('active');
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
                if (fix.acc > FIX_ACCURACY_MAX_M && !confirm(
                        'This fix is only accurate to about ' + Math.round(fix.acc) +
                        ' m, so the pin could land on the wrong block. Save it anyway?')) {
                    showToast('Pin not saved', '✕');
                    consentQueue.shift();
                    if (consentQueue.length) setTimeout(showNextConsent, 300);
                    return;
                }
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
        // ---- Device identity (name / random address) ------------------------
        // Both live in the firmware's NVS and are read at boot before the BLE
        // stack comes up, so saving either restarts the board. The device is
        // the source of truth -- with more than one board around, the app must
        // never assume it knows what a given device is called. We ask on
        // connect (CMD:CFG) rather than have the firmware push it every second;
        // identity is static config and the 1 Hz payload is the tight budget.
        function applyConfigToSettings(cfg) {
            const nameEl = document.getElementById('cfg-name');
            const rndEl  = document.getElementById('cfg-randmac');
            if (nameEl && typeof cfg.ble_name === 'string') nameEl.value = cfg.ble_name;
            if (rndEl) rndEl.checked = !!cfg.rand_mac;
            setRxOnlyUi(!!cfg.rx_only);
            setRadioUi(cfg);
        }

        // The device is the authority on the radios too: the toggles never
        // paint themselves optimistically, they paint what the last cfg reply
        // said, and the firmware answers every BLE_SCAN/WIFI_SCAN command with
        // a fresh one. Absent keys (older firmware) leave the button alone.
        function setRadioUi(cfg) {
            const paint = (id, on) => {
                const b = document.getElementById(id);
                if (!b || typeof on !== 'boolean') return;
                b.textContent = on ? 'Scanning' : 'Paused';
                b.classList.toggle('on', on);
                b.classList.toggle('off', !on);
                b.dataset.on = on ? '1' : '0';
            };
            paint('btn-ble-scan', cfg.ble_scan);
            paint('btn-wifi-scan', cfg.wifi_scan);
        }

        function toggleRadio(id, cmdPrefix) {
            const b = document.getElementById(id);
            const on = !b || b.dataset.on !== '0';
            sendCommand({ raw: cmdPrefix + (on ? ':OFF' : ':ON') });
        }
        function toggleBleScan()  { toggleRadio('btn-ble-scan', 'CMD:BLE_SCAN'); }
        function toggleWifiScan() { toggleRadio('btn-wifi-scan', 'CMD:WIFI_SCAN'); }

        // The device is the authority on this; the app only mirrors what the
        // last CMD:CFG said.
        let deviceRxOnly = false;
        function setRxOnlyUi(quiet) {
            deviceRxOnly = quiet;
            const label = document.getElementById('cfg-rxonly');
            if (label) label.textContent = quiet ? 'receive-only' : 'advertising';
            const btn = document.getElementById('btn-rxonly');
            if (btn) {
                btn.textContent = quiet ? 'Advertise' : 'Go quiet';
                btn.classList.toggle('on', quiet);
                btn.classList.toggle('off', !quiet);
            }
        }

        // Deliberately a toggle, not a one-way door. Over BLE, going quiet
        // severs the link that carries the command, so the only way back is
        // the BOOT button. Over a USB cable nothing is severed at all -- the
        // radio goes quiet and the wire keeps working -- so the app must be
        // able to put the device back on the air. A control that could only
        // ever silence would strand the operator in the one situation where
        // recovery is trivial.
        function toggleReceiveOnly() {
            if (deviceRxOnly) {
                sendCommand({ rx_only: false });
                setRxOnlyUi(false);
                showToast('Advertising again', '✓');
                return;
            }
            const overBle = connectionType === 'BLE';
            const warning = overBle
                ? 'THIS CONNECTION WILL DROP and the app will not reconnect on its own. ' +
                  'Tap the BOOT button on the device to make it discoverable again for ' +
                  'two minutes.'
                : 'This cable is unaffected and keeps full control -- only the radio ' +
                  'goes quiet. Bluetooth clients will not see the device until you ' +
                  'turn advertising back on here, or tap BOOT.';
            if (!confirm(
                'Receive-only stops the device advertising itself, so nobody — ' +
                'including whatever it is watching for — can see it on the air.\n\n' +
                warning + '\n\nIt keeps scanning and keeps beeping.')) return;
            sendCommand({ rx_only: true });
            // Only meaningful on BLE: stand down the capped-backoff loop,
            // because the device is deliberately gone rather than faulty.
            if (overBle) cancelReconnect();
            setRxOnlyUi(true);
            showToast(overBle ? 'Receive-only — tap BOOT to return' : 'Receive-only — radio quiet', '●');
        }

        function syncDeviceState(data) {
            const devHunt = data.hunt || '';
            if (devHunt.toUpperCase() !== huntMac.toUpperCase()) {
                huntMac = devHunt;
                huntTrace = [];
            }
            const devAll = !!data.scan_all;
            if (devAll !== foxhuntMode) {
                foxhuntMode = devAll;
                const radios = document.getElementById('radios');
                if (radios) radios.style.display = foxhuntMode ? 'grid' : 'none';
                if (!foxhuntMode) setRadio('any');
                const btn = document.getElementById('btn-foxhunt');
                if (btn) {
                    btn.classList.toggle('on', foxhuntMode);
                    btn.textContent = foxhuntMode ? '◉ Filter: off' : '◎ Filter: matches';
                }
            }
        }

        function requestConfig() {
            sendCommand({ raw: 'CMD:CFG' });
        }

        function saveIdentity() {
            const nameEl = document.getElementById('cfg-name');
            const rndEl  = document.getElementById('cfg-randmac');
            const name = nameEl ? nameEl.value.trim() : '';
            const rand = rndEl ? !!rndEl.checked : false;
            if (rand && !confirm(
                'Randomizing the BLE address means the phone cannot silently reconnect ' +
                'after the device reboots \u2014 you will have to pick it from the dialog ' +
                'every time. Turn it on anyway?')) {
                if (rndEl) rndEl.checked = false;
                return;
            }
            // Empty name is meaningful: it restores the "SignalSweep" default.
            sendCommand({ ble_name: name, rand_mac: rand });
            showToast('Saved \u2014 device is restarting', '\u21bb');
        }

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
            // Two different transports reach the same cable: WebSerial in a
            // desktop browser, and the Android USB host stack through the
            // plugin. Show the button wherever either exists, and hide it
            // where neither does rather than offering a control whose only
            // outcome is an alert.
            const serialBtn = document.getElementById('btnConnSerial');
            const serialSub = document.getElementById('connSerialSub');
            const usbNative = nativeUsbAvailable();
            const usbWeb = 'serial' in navigator;
            if (usbNative || usbWeb) {
                serialBadge.className = 'api-badge ok';
                serialBadge.textContent = usbNative ? 'Native USB host' : 'Supported';
                if (serialSub) serialSub.textContent = usbNative
                    ? 'USB-C cable, 115200 baud'
                    : '115200 baud serial stream';
                if (serialBtn) serialBtn.hidden = false;
            } else {
                serialBadge.className = 'api-badge warn'; serialBadge.textContent = 'Not Supported';
                if (serialBtn) serialBtn.hidden = true;
            }
        }

        // Backdrop click and Escape close whatever modal is open. Settings is
        // tall enough to scroll on a phone, which can push the x off the top of
        // the screen -- a modal you can scroll must have a way out that does not
        // depend on scrolling back up. The PIN gate is included deliberately:
        // dismissing it just leaves the store locked.
        document.addEventListener('click', (e) => {
            if (e.target.classList && e.target.classList.contains('modal-overlay')) {
                e.target.classList.remove('active');
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
        });

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
                renderStatusStrip();
                showToast(`Connected via ${type}`, '✓');
                // Ask the device what it is called. Done here rather than at
                // each of the five connect sites, and after a beat so the NUS
                // notify subscription is actually up before the reply lands.
                setTimeout(requestConfig, 400);
            } else {
                connectionType = null;
                pulseDot.className = 'pulse-dot';
                connStatusText.textContent = 'DISCONNECTED';
                btnConnectHeader.style.display = 'flex';
                btnDisconnectHeader.style.display = 'none';
                connBanner.style.display = 'flex';
                renderStatusStrip();
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
                // Always show the picker. This used to adopt whatever
                // getConnectedDevices() returned first, which meant Android's
                // still-alive GATT link to the last board silently won and the
                // picker never opened -- there was no way to reach a second
                // device. An explicit Connect tap means "let me choose"; the
                // silent path that still exists is auto-reconnect after a drop
                // (tryReconnect) and reconcileConnection on resume.
                // The filter is the NUS service UUID, not the name, so a
                // renamed board still appears.
                const device = await window.BleClient.requestDevice({
                    services: [NUS_SERVICE_UUID], optionalServices: [NUS_SERVICE_UUID]
                });
                // Picking a board the OS is already connected to throws; that
                // is success, not failure.
                try { await window.BleClient.connect(device.deviceId, () => onDeviceDisconnected()); } catch (e) { /* already connected */ }
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

        // =====================================================================
        //  Native USB serial (Android)
        // =====================================================================
        // Android has no WebSerial at all -- the API is absent from the
        // platform -- so a phone can only reach the device over a cable
        // through the USB host stack directly. That matters because
        // receive-only deliberately severs the BLE link: without this, going
        // quiet from the phone left the phone with no way back to the device
        // it had just silenced.
        //
        // The board is a CDC/ACM device (ARDUINO_USB_CDC_ON_BOOT=1, Espressif
        // VID 0x303A), which usb-serial-for-android identifies by interface
        // class, so no custom prober is needed.
        const USB_VID_ESPRESSIF = 0x303A;
        let usbPortId = null;
        let usbListeners = [];
        // Kept across events: a UTF-8 sequence can straddle two data callbacks,
        // and a fresh decoder per chunk would turn a split character into
        // replacement bytes. Device names and SSIDs are chosen by whatever
        // hardware is being observed, so assuming ASCII is not safe.
        const usbDecoder = new TextDecoder('utf-8');

        function nativeUsbAvailable() {
            return !!(window.Capacitor && window.Capacitor.isNativePlatform() && window.UsbSerial);
        }

        function b64ToBytes(b64) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return bytes;
        }
        function bytesToB64(bytes) {
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
        }

        // The modal button. Same shape as connectWebBluetooth forking to
        // connectNativeBluetooth: one control, the platform picks the path.
        async function connectUsb() {
            if (nativeUsbAvailable()) return connectNativeUsb();
            return connectWebSerial();
        }

        async function connectNativeUsb() {
            const pulseDot = document.getElementById('pulseDot');
            const connStatusText = document.getElementById('connStatusText');
            pulseDot.className = 'pulse-dot connecting';
            connStatusText.textContent = 'CONNECTING USB...';
            try {
                const { devices } = await window.UsbSerial.listDevices();
                if (!devices || devices.length === 0) {
                    updateConnectionUI(false);
                    showToast('No USB device found — check the cable supports data', '✕');
                    return;
                }
                // Prefer the board over whatever else is on the bus (a hub, a
                // charger's control chip); fall back to the first device so an
                // unusual build is still reachable.
                const dev = devices.find(d => d.vendorId === USB_VID_ESPRESSIF) || devices[0];

                if (!dev.hasPermission) {
                    // Android's own dialog. A decline resolves granted:false
                    // rather than throwing, so this is a branch, not a catch.
                    const { granted } = await window.UsbSerial.requestPermission({ deviceId: dev.deviceId });
                    if (!granted) {
                        updateConnectionUI(false);
                        showToast('USB permission denied', '✕');
                        return;
                    }
                }

                const { portId } = await window.UsbSerial.open({ deviceId: dev.deviceId });
                usbPortId = portId;
                await window.UsbSerial.setParameters({
                    portId, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none'
                });

                usbListeners.push(await window.UsbSerial.addListener('data', (ev) => {
                    if (ev.portId !== usbPortId) return;
                    // Straight into the same line reassembler BLE and WebSerial
                    // feed. One parser, three transports.
                    processIncomingChunk(usbDecoder.decode(b64ToBytes(ev.data), { stream: true }));
                }));
                usbListeners.push(await window.UsbSerial.addListener('detached', () => {
                    showToast('USB device unplugged', '✕');
                    onDeviceDisconnected();
                }));
                usbListeners.push(await window.UsbSerial.addListener('error', (ev) => {
                    console.warn('USB stream error:', ev && ev.message);
                }));

                await window.UsbSerial.startReading({ portId });
                updateConnectionUI(true, 'USB');
                offerReceiveOnlyOnCable();
            } catch (err) {
                console.error('USB connect failed:', err);
                usbPortId = null;
                updateConnectionUI(false);
                showToast(`USB Connect Failed: ${(err && (err.code || err.message)) || err}`, '✕');
            }
        }

        async function teardownUsb() {
            for (const sub of usbListeners) { try { await sub.remove(); } catch (e) {} }
            usbListeners = [];
            if (usbPortId && window.UsbSerial) {
                try { await window.UsbSerial.stopReading({ portId: usbPortId }); } catch (e) {}
                try { await window.UsbSerial.close({ portId: usbPortId }); } catch (e) {}
            }
            usbPortId = null;
        }

        // A hint, deliberately NOT a dialog. This used to be a confirm() fired
        // the instant the port opened -- which on Android put it in the same
        // screen region as the system USB-permission dialog, milliseconds
        // after it, so the tap that granted permission carried straight
        // through onto its OK and silenced the device nobody had asked to
        // silence. Measured on the bench: {"rx_only":true} went out 100 ms
        // after connect with no human input. Silencing the detector is a
        // deliberate act and it lives behind a deliberate control.
        function offerReceiveOnlyOnCable() {
            showToast('On the cable — Settings can stop the radio advertising', '✓');
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
                offerReceiveOnlyOnCable();
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
            } else if (connectionType === 'USB' && usbPortId) {
                try {
                    await window.UsbSerial.write({
                        portId: usbPortId,
                        data: bytesToB64(new TextEncoder().encode(jsonStr))
                    });
                    return true;
                } catch (err) {
                    console.error('USB write error:', err);
                    showToast(`USB Transmit Error: ${(err && (err.code || err.message)) || err}`, '\u2715');
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
            } else if (window.BleClient) {
                // The UI can say "disconnected" while Android still holds the
                // GATT link -- after an app restart, bleDevice is null but the
                // OS link survived. Without this, Disconnect is a no-op on that
                // zombie and it keeps taking the reconnect path.
                try {
                    const stale = await window.BleClient.getConnectedDevices([NUS_SERVICE_UUID]);
                    for (const d of (stale || [])) await window.BleClient.disconnect(d.deviceId);
                } catch (e) { /* BLE unavailable or nothing connected */ }
            }
            await teardownUsb();
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
            // Fire and forget: the cable may already be gone, in which case
            // every call inside throws and none of it matters. wantConnection
            // is only ever set on the native BLE path, so a yanked cable does
            // not start a BLE backoff loop.
            if (usbPortId || usbListeners.length) teardownUsb();
            clearLiveState();
            updateConnectionUI(false);
            if (wantConnection) scheduleReconnect();
        }

        // Drop everything the device told us. This is the "no passive trail"
        // property actually being enforced rather than merely described: rows
        // aged out of the VIEW after LIVE_STALE_MS, but liveMatches itself kept
        // every MAC, name and RSSI of the whole session in memory -- and now it
        // would also hold decoded drone and operator coordinates. Nothing here
        // was ever written to disk, but a session-long list in a live tab is
        // still a list, so it goes when the link does.
        //
        // Deliberately NOT cleared: handledMacs (the per-device "already asked
        // about recording" set), because a flapping BLE link would otherwise
        // re-prompt for consent on every reconnect.
        function clearLiveState() {
            liveMatches = {};
            mapFix = null;
            huntMac = '';
            huntTrace = [];
            if (liveLayer) liveLayer.clearLayers();
            if (meLayer) meLayer.clearLayers();
            renderScope();
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

                // Lens filtering. The lens must never be able to hide a match
                // from its own tab, and 'all' must never hide anything -- the
                // detector sees everything, so the UI has to be able to show
                // everything. Also checks that the drone block survives ingest.
                liveMatches = {};
                ingestTargets([
                    { mac: 'AA:00:01', type: 'Flock Safety',           rssi: -50, confidence: 80 },
                    { mac: 'AA:00:02', type: 'Axon',                   rssi: -60, confidence: 80 },
                    { mac: 'AA:00:03', type: 'Tracker',                rssi: -70, confidence: 80 },
                    { mac: 'AA:00:04', type: 'Drone', uas_id: 'X7',    rssi: -80, confidence: 90,
                      lat: 30.2, lng: -92.0, op_lat: 30.1, op_lng: -92.1, alt: 120, speed: 4.5 }
                ]);
                results.lensAll     = liveRows('all').length === 4;
                results.lensDrone   = liveRows('drone').length === 1;
                results.lensTracker = liveRows('tracker').length === 1;
                // Surveillance is the umbrella over ALPR + body cam.
                results.lensAlpr    = liveRows('alpr').length === 2;
                // Strongest-first ordering is what the list relies on.
                results.lensSorted  = liveRows('all')[0].mac === 'AA:00:01';
                const drone = liveMatches['AA:00:04'];
                results.droneFields = drone.uasId === 'X7' && drone.lat === 30.2 &&
                                      drone.opLat === 30.1 && drone.alt === 120;
                // Detail line renders the decoded values, escaped.
                results.droneDetail = detailLine(drone, categoryOf('Drone')).indexOf('X7') > 0;
                // A device-chosen name must never reach the DOM as markup.
                results.escapesName = esc('<img src=x onerror=1>').indexOf('<') === -1;
                // Location badge states. "Off" and "no fix" mean opposite
                // things -- one is resting, one is a problem -- and a vague fix
                // has to be called out rather than shown as a good one.
                setGpsState('off');       results.gpsOff      = gpsDisplay().dot === 'off';
                setGpsState('locating');  results.gpsLocating = gpsDisplay().dot === 'warn';
                setGpsState('denied');    results.gpsDenied   = gpsDisplay().dot === 'bad';
                setGpsState('fix', 12);   results.gpsGood     = gpsDisplay().dot === 'ok';
                setGpsState('fix', 250);
                results.gpsVague = gpsDisplay().dot === 'warn' &&
                                   gpsDisplay().text.indexOf('too vague') > 0;
                setGpsState('off');

                // Meter scaling: clamped at both ends, monotonic in between.
                results.meterScale = rssiFrac(-999) === 0 && rssiFrac(0) === 1 &&
                                     rssiFrac(-40) > rssiFrac(-80);

                // With the filter off, an unmatched device must be listed but
                // never dressed up as a detection, and must never trigger a
                // request to pin it.
                foxhuntMode = true;
                recordEnabled = true;
                consentQueue = [];
                handledMacs.clear();
                liveMatches = {};
                ingestTargets([
                    { mac: 'BB:00:01', rssi: -55, confidence: 0 },              // unmatched
                    { mac: 'BB:00:02', rssi: -60, confidence: 80, type: 'Tracker' }
                ]);
                results.pinsOnlyMatches = consentQueue.length === 1 &&
                                          consentQueue[0].mac === 'BB:00:02';
                // An unmatched device is its own state: no category, no icon,
                // and above all not counted as a camera.
                results.noMatchIsOwnBand = categoryOf('').key === 'none' &&
                                           categoryOf('').icon === '' &&
                                           liveRows('alpr').length === 0 &&
                                           liveRows('all').length === 2;
                // Hunt is offered on anything while the filter is off.
                results.huntAnyInFoxhunt =
                    actionRow(liveMatches['BB:00:01'], categoryOf('')).indexOf('data-act="hunt"') > 0;
                foxhuntMode = false;
                results.huntTrackersOnly =
                    actionRow(liveMatches['BB:00:01'], categoryOf('')) === '';
                recordEnabled = false;
                consentQueue = [];
                handledMacs.clear();

                // Radio filter, SSID display, and the weak-hint band.
                foxhuntMode = true;
                liveMatches = {};
                ingestTargets([
                    { mac: 'CC:00:01', type: 'Flock Safety', matched_rule: 'Flock Safety MAC',
                      rssi: -50, protocol: 'BLE', confidence: 85, tier: 'Confirmed' },
                    // The real-world case: a consumer camera on Lite-On silicon.
                    // It matched a rule, but the firmware deliberately declines
                    // to name a vendor, so it must NOT land under Cameras.
                    { mac: 'CC:00:02', matched_rule: 'Lite-On Vendor IE (weak)',
                      rssi: -60, protocol: 'WiFi', ssid: 'NestCam_5G', confidence: 30 },
                    { mac: 'CC:00:03', rssi: -70, protocol: 'WiFi', ssid: 'HomeNet' },
                    { mac: 'CC:00:04', type: 'Tracker', matched_rule: 'Apple Find My Tracker',
                      rssi: -80, protocol: 'BLE', confidence: 80, tier: 'Confirmed' }
                ]);
                results.weakIsNotACamera = bandOf(liveMatches['CC:00:02']) === 'weak' &&
                                           liveRows('alpr').length === 1;
                results.ssidCarried = liveMatches['CC:00:02'].ssid === 'NestCam_5G';

                setRadio('WiFi');
                results.radioWifi = liveRows('all').length === 2;
                setRadio('BLE');
                results.radioBle = liveRows('all').length === 2;
                setRadio('any');
                results.radioAny = liveRows('all').length === 4;

                // Ring is a Bluetooth write: never offer it on a Wi-Fi-only row.
                const wifiOnly = actionRow(liveMatches['CC:00:03'], categoryOf(''));
                const bleRow = actionRow(liveMatches['CC:00:04'], categoryOf('Tracker'));
                results.noRingOnWifi = wifiOnly.indexOf('data-act="ring"') === -1 &&
                                       wifiOnly.indexOf('data-act="hunt"') > 0;
                results.ringOnBle = bleRow.indexOf('data-act="ring"') > 0;
                foxhuntMode = false;

                // Disconnect drops the whole live set, not just the view.
                clearLiveState();
                results.clearsOnDisconnect = Object.keys(liveMatches).length === 0 &&
                                             huntTrace.length === 0 && huntMac === '';

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
