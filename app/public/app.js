// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

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
            // ALPR before body cam, as in the firmware's alertCategoryFromName():
            // "ALPR / Camera" and "Surveillance Camera" both contain "cam".
            // SoundThinking (ShotSpotter) is named here because the Cameras tab
            // is strictly ALPR + mass surveillance: anything without a keyword
            // lands in 'other', which is under Everything only.
            if (c.indexOf('flock') >= 0 || c.indexOf('alpr') >= 0 || c.indexOf('plate') >= 0 || c.indexOf('surveil') >= 0 ||
                c.indexOf('soundthinking') >= 0 || c.indexOf('shotspotter') >= 0)
                return { key: 'alpr',    label: 'ALPR / Camera', color: '#ef4444', icon: '📷' };
            if (c.indexOf('body') >= 0 || c.indexOf('axon') >= 0 || c.indexOf('cam') >= 0)
                return { key: 'bodycam', label: 'Body Cam',   color: '#ff5a1a', icon: '🎥' };
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

        // Which radio heard it. The firmware sends "BLE", "WiFi" or "BLE+WiFi".
        // It used to be a word buried in the grey sub-line, which is unreadable
        // in a wall of rows, so it leads the title as a chip instead. Fixed
        // literals only — nothing device-supplied, nothing to escape.
        // `ap` is the firmware's link role: 1 = access point (beacons), 0 =
        // client (probe requests), undefined = not known / older firmware.
        // Band from the firmware's per-target channel ("ch"). Fixed literals
        // only -- nothing device-supplied reaches the chip text but a number.
        function bandOfChannel(ch) {
            const c = Number(ch);
            if (c >= 1 && c <= 14) return '2.4';
            if (c >= 36 && c <= 177) return '5';
            return null;
        }
        function bandChip(ch) {
            const b = bandOfChannel(ch);
            return b ? '<span class="radio-badge chan">' + b + 'G · ch ' + Number(ch) + '</span>' : '';
        }

        function radioBadges(protocol, ap, ch) {
            const p = String(protocol || '');
            const wifi = ap === 1 ? '📡 AP' : ap === 0 ? '📱 Client' : 'Wi‑Fi';
            return (p.indexOf('BLE')  >= 0 ? '<span class="radio-badge ble">BLE</span>' : '') +
                   (p.indexOf('WiFi') >= 0 ? '<span class="radio-badge wifi">' + wifi + '</span>' : '') +
                   (p.indexOf('WiFi') >= 0 ? bandChip(ch) : '');
        }

        // ---- Vendor names -------------------------------------------------
        // Looked up OFFLINE from lists bundled in public/ (refresh with
        // tools/fetch-vendors.mjs). Never an online OUI API: that would hand
        // every MAC the device hears to a third party.
        // ponytail: ~1 MB OUI list, fetched once on first render; a trimmed
        // list is the upgrade if the bundle size ever matters.
        let ouiNames = new Map();   // 'AABBCC' -> vendor
        let btNames = new Map();    // BT SIG company id -> company
        let vendorsRequested = false;
        function loadVendors() {
            if (vendorsRequested || typeof fetch !== 'function') return;
            vendorsRequested = true;
            const text = function (u) { return fetch(u).then(function (r) { return r.ok ? r.text() : Promise.reject(u); }); };
            const parse = function (t, key) {
                const out = new Map();
                for (const line of t.split(/\r?\n/)) {
                    const i = line.indexOf('\t');
                    if (i > 0) out.set(key(line.slice(0, i)), line.slice(i + 1));
                }
                return out;
            };
            Promise.all([text('oui.txt'), text('bt-company.txt')]).then(function (r) {
                ouiNames = parse(r[0], String);
                btNames = parse(r[1], Number);
                renderScope();
            }).catch(function () { /* no names; rows still render. selftest.js checks the files ship. */ });
        }
        // Only a globally-unique address names its maker. BLE says so itself
        // (`pub`); for Wi-Fi the locally-administered bit (0x02 of the first
        // byte) marks a randomized MAC, which carries no vendor at all.
        function publicMac(m) {
            if (m.pub) return true;
            if (String(m.protocol || '').indexOf('WiFi') < 0) return false;
            return (parseInt(String(m.mac).slice(0, 2), 16) & 0x02) === 0;
        }
        // The registry wins wherever it applies. A public address's OUI was
        // assigned by the IEEE; a BLE company ID is whatever the firmware put
        // there, and cheap silicon puts junk (Govee's Telink thermometers send
        // 0x0001, which is Nokia -- seen on the bench). The company ID is the
        // fallback for random addresses and "Private" registrations.
        function vendorOf(m) {
            const o = publicMac(m) ? ouiNames.get(String(m.mac).replace(/[:-]/g, '').slice(0, 6).toUpperCase()) : '';
            if (o && o !== 'Private') return o;
            return (m.cid != null && btNames.get(m.cid)) || '';
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
                const prev = liveMatches[t.mac];
                liveMatches[t.mac] = {
                    mac: t.mac, name: t.name || '', type: t.type || '',
                    rule: t.matched_rule || '', rssi: t.rssi,
                    protocol: t.protocol || 'BLE', ssid: t.ssid || '',
                    ap: t.ap, pub: !!t.pub, cid: t.cid, ring: !!t.ring,
                    // Last known channel: a push that omits it (older firmware,
                    // a BLE sighting of a BLE+WiFi device) must not blank the badge.
                    ch: t.ch != null ? t.ch : (prev ? prev.ch : undefined),
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
        // This is what replaces the old four-mode selector. The firmware is one
        // always-on detector watching every category at once, and a lens
        // cannot make it miss anything. A tab tap does set one thing on the
        // device: a preset beep mask (LENS_MASK), so the board alerts only for
        // what you are looking at. That is the same persisted mask the Alerts
        // sheet edits. It gates the beep and the light, never detection or
        // the list, so every band still counts what it hears.
        let lens = 'all';
        let viewMode = 'list';   // 'list' | 'map'

        function paintLens(key) {
            lens = key;
            document.querySelectorAll('#bands .band').forEach(function (el) {
                el.setAttribute('aria-selected',
                    el.getAttribute('data-lens') === key ? 'true' : 'false');
            });
            renderScope();
        }

        // Tab tap. Tapping the selected tab again goes back to Everything.
        // The tab paints now, and the mask goes through the same pendingMask
        // echo window as toggleBeep(), so a push that lands before the echo
        // cannot flip it back. If the write never lands, intent expires and
        // the next push repaints what the device actually has.
        function setLens(key) {
            if (key === lens && key !== 'all') key = 'all';
            paintLens(key);
            setPinLens(key);
            if (deviceBeepMask === null) return;   // not connected: view only
            pendingMask = LENS_MASK[key];
            pendingSince = Date.now();
            sendCommand({ beep_mask: pendingMask });
            setSoundsSummary();
        }

        // ---- Tabs ------------------------------------------------------------
        // Three panels under one header, switched by the bottom bar. Deliberately
        // not persisted: the app opens on Sweep because that is what the device
        // is for, and because a phone that reopens on Settings after a reboot
        // looks like it lost the connection.
        let currentTab = 'sweep';
        function showTab(name) {
            currentTab = name;
            document.querySelectorAll('.tab').forEach(el => {
                el.classList.toggle('active', el.id === 'tab-' + name);
            });
            document.querySelectorAll('#tabbar button').forEach(b => {
                b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
            });
            window.scrollTo(0, 0);
            // Survey's two lists are built on demand; Sweep repaints itself on
            // the next push, and the map needs its size recomputed after being
            // display:none (Leaflet measures a hidden container as 0x0).
            if (name === 'survey') {
                if (!capturing) capStat = { wifi: 0, ble: 0, drops: 0, remain: capReqSecs };
                paintCapture();
                renderFinds();
                renderPins();
            } else if (name === 'sweep' && viewMode === 'map' && map) {
                setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 0);
            }
        }

        document.addEventListener('click', (e) => {
            const t = e.target.closest('#tabbar button');
            if (t) showTab(t.dataset.tab);
        });

        // Transient link state ("connecting", "reconnecting") painted into the
        // header's own connection line. It used to go to a hidden status badge,
        // so the app looked frozen for the whole of a slow BLE connect; the next
        // renderStatusStrip() overwrites it with the real board name.
        function setConnState(cls, text) {
            const d = document.getElementById('hdr-dot');
            const t = document.getElementById('hdr-dev');
            if (d) d.className = 'statdot ' + cls;
            if (t) t.textContent = text;
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
        // Wi-Fi sub-filter, from the firmware's `ap` field. It only applies
        // (and is only on screen) while the Wi-Fi tab is selected, so a choice
        // left behind can never silently hide rows under another tab.
        let wifiRole = 'any';   // 'any' | 'ap' | 'client'

        // Radio and role are two variables but only five combinations are
        // reachable, so they are one row of five chips. They used to be two
        // rows, the second appearing and vanishing with the Wi-Fi tab, which
        // moved everything below it by a row mid-scan.
        const RADIO_CHIPS = {
            any:    ['any',  'any'],
            BLE:    ['BLE',  'any'],
            WiFi:   ['WiFi', 'any'],
            ap:     ['WiFi', 'ap'],
            client: ['WiFi', 'client']
        };
        function radioChipKey() {
            if (radio === 'any') return 'any';
            if (radio === 'BLE') return 'BLE';
            return wifiRole === 'any' ? 'WiFi' : wifiRole;
        }
        function paintRadioChips() {
            const sel = radioChipKey();
            document.querySelectorAll('#radios .radio-tab').forEach(function (el) {
                el.setAttribute('aria-selected',
                    el.getAttribute('data-radio') === sel ? 'true' : 'false');
            });
        }
        function setRadioChip(key) {
            const pair = RADIO_CHIPS[key];
            if (!pair) return;
            radio = pair[0];
            wifiRole = pair[1];
            paintRadioChips();
            renderScope();
        }
        // Kept as separate setters: they are the two independent variables
        // matchesRadio() reads, and app.js's own self-test drives them directly.
        function setRadio(key) { radio = key; paintRadioChips(); renderScope(); }
        function setWifiRole(key) { wifiRole = key; paintRadioChips(); renderScope(); }

        // A device seen on both radios counts as either.
        function matchesRadio(m) {
            if (radio === 'any') return true;
            if (String(m.protocol || '').indexOf(radio) < 0) return false;
            if (radio !== 'WiFi' || wifiRole === 'any') return true;
            return m.ap === (wifiRole === 'ap' ? 1 : 0);
        }

        // Is this row in band k? Shared by the list and the pin filter.
        function inLens(m, k) {
            if (k === 'all') return true;
            const c = bandOf(m);
            // "Cameras" is strictly ALPR + mass surveillance: the two buzzer
            // words ALPR and body cam (Axon counts as mass surveillance here).
            // NOT 'other' -- fleet routers, and any category with no keyword,
            // are Everything only, or a police-car router reads as a camera.
            // Not 'weak' either -- see bandOf(). LENS_MASK.alpr mirrors this.
            if (k === 'alpr') return c === 'alpr' || c === 'bodycam';
            return c === k;
        }

        // Live rows: heard recently, matching the current lens, strongest first.
        function liveRows(forLens) {
            const now = Date.now();
            const k = forLens || lens;
            const rows = Object.values(liveMatches)
                .filter(function (m) { return now - m.ts < LIVE_STALE_MS; })
                // Filter on hides unmatched rows at once. The device stops
                // reporting them, but waiting for them to go stale left the
                // whole unfiltered list on screen for 8 s after the tap.
                .filter(function (m) {
                    return foxhuntMode || bandOf(m) !== 'none' ||
                        String(m.mac).toUpperCase() === huntMac.toUpperCase();
                })
                .filter(matchesRadio)
                .filter(function (m) { return inLens(m, k); })
                // Bucketed to 5 dB, MAC as tiebreak. Sorting on raw RSSI made
                // the list dance: a couple of dB of multipath swaps two rows,
                // every push, and you tap the wrong device because the one you
                // aimed at moved. Strongest-first still holds; the jitter does
                // not move anything.
                .sort(function (a, b) {
                    const ba = Math.round((Number(a.rssi) || -999) / 5);
                    const bb = Math.round((Number(b.rssi) || -999) / 5);
                    if (ba !== bb) return bb - ba;
                    return String(a.mac) < String(b.mac) ? -1 : 1;
                });
            // The hunted card is pinned to the top, directly under the
            // instrument, so the meter, the trace, "stop hunting" and the card
            // are all on screen at once -- you found it halfway down a long
            // list, and the readout is at the top of that list.
            if (huntMac) {
                const at = rows.findIndex(function (m) {
                    return String(m.mac).toUpperCase() === huntMac.toUpperCase();
                });
                if (at > 0) rows.unshift(rows.splice(at, 1)[0]);
            }
            return rows;
        }

        // ---- Same-box grouping ---------------------------------------------
        // A dual-band router or mesh node transmits from near-identical MACs:
        // same first five octets, last octet a few apart. Field captures (C5,
        // 2026-09-15) put ~32% of 5 GHz-only transmitters in exactly that
        // relation to a box already heard on 2.4 GHz. SSID never joins rows:
        // mesh networks and public hotspots share names across unrelated boxes,
        // and 44% of 5 GHz-only transmitters never send one.
        const SIBLING_SPAN = 4;
        // Two ways a pair of Wi-Fi rows is one box, chained through a group:
        //  * near-MAC radios: first 5 octets equal, last octet within SIBLING_SPAN
        //    (a dual-band box's 2.4 and 5 GHz radios);
        //  * virtual networks: last 5 octets equal, first octet differs, at least
        //    one with the locally-administered bit (0x02), same channel when both
        //    are known (guest / IoT / hotspot SSIDs on one radio). On six C5 field
        //    drives this rule found 941 groups; every one had at most one
        //    non-local MAC, 791 shared a channel and 3 did not -- those 3 pairs
        //    are exactly what the channel check refuses. Both rules together
        //    took the list from 6886 transmitters to 3665 rows.
        function groupSiblings(rows) {
            const parent = new Map();   // row -> row (union-find)
            const find = function (x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
            const union = function (x, y) { parent.set(find(x), find(y)); };
            const byHead = new Map(), byTail = new Map(), hex = new Map();
            for (const m of rows) {
                const o = m.protocol === 'WiFi' ? String(m.mac).toUpperCase().split(/[:-]/) : null;
                if (!o || o.length !== 6 || !o.every(function (x) { return /^[0-9A-F]{2}$/.test(x); })) continue;
                parent.set(m, m);
                hex.set(m, o.join(':'));
                const e = { m: m, first: parseInt(o[0], 16), last: parseInt(o[5], 16) };
                const h = o.slice(0, 5).join(':'), t = o.slice(1).join(':');
                if (!byHead.has(h)) byHead.set(h, []);
                if (!byTail.has(t)) byTail.set(t, []);
                byHead.get(h).push(e);
                byTail.get(t).push(e);
            }
            byHead.forEach(function (list) {
                list.sort(function (a, b) { return a.last - b.last; });
                for (let i = 1; i < list.length; i++)
                    if (list[i].last - list[i - 1].last <= SIBLING_SPAN) union(list[i].m, list[i - 1].m);
            });
            byTail.forEach(function (list) {
                for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
                    const a = list[i], b = list[j];
                    if (a.first === b.first || !((a.first | b.first) & 0x02)) continue;
                    const ca = Number(a.m.ch), cb = Number(b.m.ch);
                    if (ca > 0 && cb > 0 && ca !== cb) continue;
                    union(a.m, b.m);
                }
            });
            const groupOf = new Map();   // root row -> group
            const units = [];
            for (const m of rows) {
                if (!parent.has(m)) { units.push({ key: String(m.mac).toUpperCase(), members: [m] }); continue; }
                const r = find(m);
                let g = groupOf.get(r);
                if (!g) { g = { key: hex.get(m), members: [] }; groupOf.set(r, g); units.push(g); }
                g.members.push(m);
                // Key on the group's lowest MAC: stable while its members stay,
                // and two groups can never share one (a MAC is in one group).
                if (hex.get(m) < g.key) g.key = hex.get(m);
            }
            return units;
        }
        // The row that speaks for a group: a real vendor category beats a weak
        // hint beats no match. Ties keep the first member in list order --
        // that is not always the strongest signal, because hunt pinning can
        // splice the hunted radio to the front regardless of its RSSI.
        function unitLead(members) {
            const rank = function (m) { const b = bandOf(m); return b === 'none' ? 0 : b === 'weak' ? 1 : 2; };
            let best = members[0];
            for (const m of members) if (rank(m) > rank(best)) best = m;
            return best;
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
            // Ring writes the standard Immediate Alert characteristic, which
            // only Find Me / Proximity keyfobs have. AirTags, Tiles and phones
            // ignore it, so the button appears only where the firmware heard
            // 0x1802/0x1803 advertised -- a button that almost never works is
            // a lie, not an option.
            const canRing = !!m.ring;
            return '<div class="scope-actions">' +
                '<button class="scope-act' + (hunting ? ' hunting' : '') +
                    '" data-act="hunt" data-mac="' + esc(m.mac) + '">' +
                    (hunting ? '\u25c9 Hunting \u2014 stop' : '\u25ce Hunt') + '</button>' +
                (canRing
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
            loadVendors();
            // Each band shows its own count and the strongest signal in it right
            // now, whether or not it is the selected band. That is the point of
            // the strip: you can be reading Drones and still see that something
            // just got loud in Trackers.
            const keys = ['all', 'alpr', 'tracker', 'drone'];
            for (let i = 0; i < keys.length; i++) {
                const bandRows = liveRows(keys[i]);
                const el = document.getElementById('n-' + keys[i]);
                if (el) el.textContent = groupSiblings(bandRows).length;
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
            if (countEl) countEl.textContent = groupSiblings(rows).length;
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

            function rowHtml(m, extraBadges, extraHtml, noActions, forceHunted) {
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
                // A group row speaks for its lead member, but the hunted
                // device inside it may not be the lead -- forceHunted lets
                // the group loop say "this unit is hunted" even when m itself
                // isn't the hunted MAC, so the outline still lands on the row
                // you're actually walking down.
                const isHunted = !!huntMac && (String(m.mac).toUpperCase() === huntMac.toUpperCase() || !!forceHunted);
                // A random address with no company ID has no maker to name;
                // say so rather than leave the blank unexplained.
                const vendor = vendorOf(m) || (publicMac(m) || m.cid != null ? '' : 'random MAC');
                return '<div class="scope-row' + (unmatched ? ' unmatched' : '') +
                        (isHunted ? ' hunted' : '') +
                        '" style="border-left:4px solid ' + cat.color + '">' +
                    '<div class="scope-main">' +
                        '<div class="scope-title">' + radioBadges(m.protocol, m.ap, m.ch) + (extraBadges || '') +
                            (cat.icon ? cat.icon + ' ' : '') + '<span class="scope-name">' + esc(title) + '</span>' +
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
                            // The protocol is a badge in the title now. Every
                            // part here is optional, so join what exists rather
                            // than leave a dangling separator behind.
                            [ esc(vendor),
                              (title === m.mac ? '' : '<span class="mono">' + esc(m.mac) + '</span>'),
                              (m.ssid && m.ssid !== title ? esc(m.ssid) : ''),
                              (m.rule ? esc(m.rule) : ''),
                              (unmatched ? '' : 'conf ' + (m.confidence | 0))
                            ].filter(Boolean).join(' \u00b7 ') + '</div>' +
                    '</div>' +
                    '<div class="scope-signal">' +
                        '<div class="scope-bars" style="color:' + cat.color + '">' + signalBars(m.rssi) + '</div>' +
                        '<div class="scope-rssi mono">' + esc(m.rssi) + ' dBm</div>' +
                    '</div>' +
                    detailLine(m, cat) +
                    (extraHtml || '') +
                    (noActions ? '' : actionRow(m, cat)) +
                '</div>';
            }

            let html = '';
            for (const u of groupSiblings(rows)) {
                if (u.members.length === 1) { html += rowHtml(u.members[0]); continue; }
                const lead = unitLead(u.members);
                const hunted = !!huntMac && u.members.some(function (m) { return String(m.mac).toUpperCase() === huntMac.toUpperCase(); });
                const open = hunted || expandedGroups.has(u.key);
                // One chip per band heard, from that band's strongest radio.
                // Fixed 2.4-then-5 order -- Object.keys on a two-entry object
                // keyed '2.4'/'5' is not guaranteed to agree with which band
                // was heard first, and a chip order that jitters between
                // renders is its own small bug.
                const byBand = {};
                u.members.forEach(function (m) { const b = bandOfChannel(m.ch); if (b && !byBand[b] && m !== lead) byBand[b] = m.ch; });
                if (bandOfChannel(lead.ch)) delete byBand[bandOfChannel(lead.ch)];
                const extraBadges = ['2.4', '5'].filter(function (b) { return byBand[b]; })
                        .map(function (b) { return bandChip(byBand[b]); }).join('') +
                    '<span class="radio-badge nradios">' + u.members.length + ' radios</span>';
                // The lead is chosen for category, which can leave it without
                // a name of its own -- 44% of 5 GHz-only transmitters never
                // send an SSID. Borrow one from any member that has it, and
                // show the strongest member's signal rather than the lead's
                // (the lead can be the weaker radio of the pair). data-mac
                // and the action buttons still come from the real `lead`.
                const ssidMember = u.members.find(function (m) { return m.ssid; });
                const strongestRssi = Math.max.apply(null, u.members.map(function (m) { return Number(m.rssi) || -999; }));
                const leadForRow = Object.assign({}, lead, {
                    ssid: lead.ssid || (ssidMember ? ssidMember.ssid : ''),
                    rssi: strongestRssi
                });
                // A hunt holds the group open on its own; the toggle button
                // would do nothing while that's true (open is already forced
                // true), so don't offer a control that has no effect.
                const extraHtml = (hunted ? '' :
                        '<div class="scope-actions"><button class="scope-act" data-act="expand" data-group="' + esc(u.key) + '">' +
                        (open ? '\u25be Hide radios' : '\u25b8 Show ' + u.members.length + ' radios') + '</button></div>') +
                    (open ? '<div class="group-members">' + u.members.map(function (m) {
                        const mc = categoryOf(m.type || m.rule);
                        return '<div class="group-member">' + bandChip(m.ch) +
                            ' <span class="mono">' + esc(m.mac) + '</span> \u00b7 <span class="mono">' + esc(m.rssi) + ' dBm</span>' +
                            actionRow(m, mc) + '</div>';
                    }).join('') + '</div>' : '');
                html += rowHtml(leadForRow, extraBadges, extraHtml, true, hunted);
            }
            list.innerHTML = html;
        }

        // ---- Hunt / Ring ----------------------------------------------------
        // Hunt is the one thing the app can change about firmware behaviour: the
        // device's buzzer becomes an RSSI-driven Geiger clicker for that MAC so
        // you can physically walk it down. Detection never stops meanwhile.
        let huntMac = '';
        let expandedGroups = new Set();   // group keys the user opened; in memory only
        let foxhuntMode = false;      // filter off: list everything, hunt anything
        // A push already in flight when you tap still carries the old scan_all,
        // and adopting it flipped the button back for a frame. Local intent
        // wins briefly; after that the device is the authority again, so a
        // write that never landed still repaints the truth.
        let filterPendingUntil = 0;
        // Signal strength for the locked target over the last ~40 samples. In
        // memory, cleared when the hunt stops or the link drops. It is a signal
        // trace, not a track -- there is no position in it.
        let huntTrace = [];
        const HUNT_TRACE_MAX = 40;

        function currentHuntMac() { return huntMac; }

        // Only append when the sample is actually new, so standing still doesn't
        // fill the trace with duplicates of one reading. Fed by both the 1 Hz
        // push and the 4 Hz hunt frame.
        function pushHuntSample(rssi, ts) {
            const last = huntTrace.length ? huntTrace[huntTrace.length - 1] : null;
            if (last && last.ts === ts) return;
            huntTrace.push({ rssi: Number(rssi), ts: ts });
            if (huntTrace.length > HUNT_TRACE_MAX) huntTrace.shift();
        }

        function toggleFoxhunt() {
            if (!connectionType) { showToast('Connect the device first', '…'); return; }
            foxhuntMode = !foxhuntMode;
            // Listing only. The buzzer stays gated by the firmware's alert
            // threshold either way, so turning the filter off shows you every
            // phone in the room without beeping at a single one.
            sendCommand({ scan_all: foxhuntMode });
            filterPendingUntil = Date.now() + 1500;
            paintFilter();
            // The radio strip is always on screen and its choice is yours, not
            // the filter's — it used to appear and reset with foxhunt mode.
            if (!foxhuntMode && huntMac) stopHunt();
            showToast(foxhuntMode ? 'Showing every device the board tracks'
                                  : 'Showing matches only',
                      foxhuntMode ? '\u25ce' : '\u25c9');
            renderScope();
        }

        // Lit means filtering, which is the normal state. It used to be lit
        // when the filter was OFF and read "Filter: matches" unlit, backwards.
        // With nothing connected the board's filter is unknown, so it shows
        // "—" like Alerts rather than a confident "On".
        function paintFilter() {
            const btn = document.getElementById('btn-foxhunt');
            if (!btn) return;
            if (!connectionType) {
                btn.classList.remove('on');
                btn.textContent = '—';
                return;
            }
            // A state, not a toggle name. "Filter: Off" meant the list was
            // showing MORE, and the word now belongs to the radio chips.
            btn.classList.toggle('on', foxhuntMode);
            btn.textContent = foxhuntMode ? 'All devices' : 'Matches only';
        }

        function huntTarget(mac) {
            const same = huntMac && huntMac.toUpperCase() === String(mac).toUpperCase();
            if (same) { stopHunt(); return; }
            huntMac = String(mac);
            huntTrace = [];
            sendCommand({ hunt: huntMac });
            showToast('Locked on \u2014 follow the beeps', '\u25c9');
            renderScope();
            // You locked on from halfway down a long list; the instrument is at
            // the top of it. Bring it to you -- the hunted card is pinned
            // directly beneath, so both land on screen together.
            const fox = document.getElementById('fox');
            if (fox && fox.scrollIntoView) fox.scrollIntoView({ block: 'start', behavior: 'smooth' });
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

            pushHuntSample(m.rssi, m.ts);

            // Warmer/colder from the last handful of samples against the ones
            // before them. 3 dB is roughly the smallest change worth acting on;
            // below that the reading is just multipath noise.
            if (trendEl) {
                const t = huntTrace.map(function (p) { return p.rssi; });
                if (t.length < 4) {
                    trendEl.textContent = 'reading\u2026';
                    trendEl.style.color = 'var(--ss-dim)';
                } else {
                    const avg = (a) => a.reduce(function (x, y) { return x + y; }, 0) / a.length;
                    // Last three samples against the three before them. At the
                    // hunt frame's 4 Hz that is ~1.5 s of history; the old
                    // 4-against-6 window was ~10 s at 1 Hz, which is why the
                    // screen read cold while the buzzer was already warming.
                    const delta = avg(t.slice(-3)) - avg(t.slice(-6, -3));
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
            showToast('Ringing\u2026', '\ud83d\udd14');
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
            if (rt) { setRadioChip(rt.getAttribute('data-radio')); return; }
            const lm = ev.target.closest('#led-modes .radio-tab');
            if (lm) { setLed(Number(lm.getAttribute('data-led'))); return; }
            const tc = ev.target.closest('#theme-modes .theme-chip');
            if (tc) { setTheme(Number(tc.getAttribute('data-theme'))); return; }
            const bm = ev.target.closest('#band-modes .radio-tab');
            if (bm) { setBand(Number(bm.getAttribute('data-band'))); return; }
            const sm = ev.target.closest('#sound-modes .radio-tab');
            if (sm) { setSound(sm.getAttribute('data-sound') === '1'); return; }
            const act = ev.target.closest('.scope-act');
            if (!act) return;
            if (act.getAttribute('data-act') === 'expand') {
                const g = act.getAttribute('data-group');
                if (expandedGroups.has(g)) expandedGroups.delete(g); else expandedGroups.add(g);
                renderScope();
                return;
            }
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
            // Capture data lines are raw base64, not JSON, and come fast -- route
            // them straight to the file writer before the JSON parser sees them.
            if (capturing && dataStr.charCodeAt(0) === 67 /* 'C' */ && dataStr.startsWith('CAP:')) {
                capAppend(dataStr.slice(4));
                return;
            }
            // Alert-log readback payload, same shape as CAP: -- raw base64, not
            // JSON, so route it before the parser. Only while a read is running.
            if (logRx && dataStr.charCodeAt(0) === 76 /* 'L' */ && dataStr.startsWith('LOG:')) {
                try { logRx.recs.push(unb64(dataStr.slice(4))); } catch (e) {}
                logRx.arm();
                return;
            }
            try {
                const data = JSON.parse(dataStr);
                rxOk++;
                // Capture progress / completion frame ({"cap":{...}}).
                if (data.cap) { handleCapStat(data.cap); return; }
                // Alert-log readback header / done frame ({"logrd":{...}}).
                if (data.logrd) { handleLogFrame(data.logrd); return; }
                // Ring result: the firmware reports whether the write landed.
                if (typeof data.ring === 'string' && 'ok' in data) {
                    showToast(data.ok ? 'Ring landed — listen for it'
                                      : 'Ring failed — out of range or not ringable',
                              data.ok ? '🔔' : '⚠');
                    return;
                }
                // The 4 Hz hunt frame: one target, one number, and deliberately
                // NOT a renderScope() -- rebuilding the list four times a second
                // would put the rows back to moving under your thumb, which is
                // the thing this whole path exists to stop.
                if ('hunt_rssi' in data) {
                    const hm = liveMatches[data.hunt] ||
                               liveMatches[Object.keys(liveMatches).find(function (k) {
                                   return k.toUpperCase() === String(data.hunt).toUpperCase();
                               })];
                    const now = Date.now();
                    if (hm) { hm.rssi = data.hunt_rssi; hm.ts = now; }
                    pushHuntSample(data.hunt_rssi, now);
                    try { renderFoxhunt(); } catch (e) { console.warn('foxhunt render failed:', e); }
                    return;
                }
                // The device is the authority on its own state. Both flags
                // persist in NVS (sweep-st), so a board that ran headless
                // comes back still hunting or still unfiltered -- the app has
                // to adopt what the telemetry says in either direction rather
                // than assume defaults. Adopted BEFORE rendering: the other
                // order drew one push under the old filter, which left stale
                // unmatched rows (with Hunt buttons) up until the next push.
                if ('targets' in data) syncDeviceState(data);
                if (data.targets) {
                    ingestTargets(data.targets);
                    renderScope();
                }
                if (data.cfg) {
                    cfgSeen = true;
                    applyConfigToSettings(data);
                    // A board that has been running headless may already be
                    // hunting something or have its filter off. Adopt that on
                    // connect rather than waiting for the first push.
                    syncDeviceState(data);
                }
                // Reply to CMD:SIGS. Carries neither `targets` nor `cfg`.
                if (Array.isArray(data.signatures)) setSigUi(data.signatures);
            } catch (e) {
                // Only a line that looks like JSON is a lost update. Opening the
                // cable resets the board, and its boot banner ("ESP-ROM:...",
                // "rst:0x15 ...") used to count as dropped telemetry: the badge
                // read "29% of updates lost" right after a clean connect.
                if (dataStr.indexOf('"') === -1) return;
                rxDropped++;
                console.warn('Data parse error (dropped ' + rxDropped + ' of ' +
                             (rxDropped + rxOk) + '):', e);
            }
        }

        // =====================================================================
        //  Environment capture (USB only): raw packet log to a phone file.
        // =====================================================================
        // The detector reports only what it already judged interesting. To find
        // an UNKNOWN signature -- e.g. a Flock camera on a randomized MAC that
        // carries only the weak Lite-On IE, which never clears the alert gate --
        // you need the raw air, not the detector's verdict. The board streams
        // base64 "CAP:" lines over USB; we append them to a file on the phone,
        // then pull it to a PC and run analyze-capture.py. BLE NUS is far too
        // slow for this, so capture is USB/SERIAL only. This is NOT a passive
        // trail: nothing is written unless the user starts a capture.
        let capturing = false;
        let capFileName = null;
        let capBuf = '';              // accumulates CAP lines between file flushes
        let capFlushTimer = null;
        let capReqSecs = 300;
        let capStat = { wifi: 0, ble: 0, drops: 0, remain: 0 };
        let capWriteFailed = false;
        let capWakeLock = null;       // keep the screen on during a capture

        // A capture streams a flood of USB data; if the screen turns off Android
        // backgrounds the WebView and the capture dies with nothing saved. A
        // screen wake lock keeps the page foreground for the duration. The lock
        // is auto-released when the page hides, so re-acquire when it returns.
        // The cable holds it too, for the whole connection (cableWake, set by
        // setHostKeepalive): with the screen off the USB stream stalls and the
        // live list goes stale, capture or not.
        let cableWake = false;
        async function capAcquireWake() {
            try { if (navigator.wakeLock && !capWakeLock) capWakeLock = await navigator.wakeLock.request('screen'); }
            catch (e) {}
        }
        function capReleaseWake() {
            if (cableWake) return;   // a capture ending must not drop the cable's hold
            try { if (capWakeLock) { capWakeLock.release(); capWakeLock = null; } } catch (e) {}
        }
        document.addEventListener('visibilitychange', () => {
            // The OS drops the lock on hide without telling us; forget it so we re-request.
            if (document.visibilityState !== 'visible') { capWakeLock = null; return; }
            if (capturing || cableWake) capAcquireWake();
        });

        function capNativeFs() {
            return !!(window.CapFilesystem && window.CapDirectory && window.CapEncoding);
        }
        function capIsUsb() {
            return connectionType === 'USB' || connectionType === 'SERIAL';
        }
        function capStamp() {
            const d = new Date(), p = n => String(n).padStart(2, '0');
            return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
                   p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        }

        // Capture now lives inline on the Finder page; this just opens it.
        function openCapture() { openFinder(); }
        // "Done" on the finished-capture panel: reset back to the idle state
        // within the Finder page (does not close the page or stop anything).
        function closeCapture() {
            lastAnalysis = null;
            paintAnalysis();
            if (!capturing) { capStat = { wifi: 0, ble: 0, drops: 0, remain: capReqSecs }; }
            paintCapture();
            renderFinds();
        }
        function pickCapDuration(secs) {
            capReqSecs = secs;
            document.querySelectorAll('.cap-dur').forEach(b =>
                b.classList.toggle('on', Number(b.dataset.secs) === secs));
        }

        function paintCapture() {
            const idle = document.getElementById('cap-idle');
            const run = document.getElementById('cap-running');
            const done = document.getElementById('cap-done');
            if (!idle) return;
            idle.style.display = capturing ? 'none' : 'block';
            run.style.display = capturing ? 'block' : 'none';
            done.style.display = 'none';
            const warn = document.getElementById('cap-usb-warn');
            const start = document.getElementById('cap-start-btn');
            const usbOk = capIsUsb() && capNativeFs();
            if (warn) warn.style.display = usbOk ? 'none' : 'block';
            // Never disable Start: a disabled button swallows the tap, and then
            // nothing says why. startCapture() explains instead.
            if (capturing) {
                const m = Math.floor(capStat.remain / 60), s = capStat.remain % 60;
                document.getElementById('cap-remain').textContent = m + ':' + String(s).padStart(2, '0');
                document.getElementById('cap-wifi').textContent = capStat.wifi;
                document.getElementById('cap-ble').textContent = capStat.ble;
                const d = document.getElementById('cap-drops');
                d.textContent = capStat.drops;
                d.style.color = capStat.drops > 0 ? 'var(--accent-red)' : '';
            }
        }

        async function startCapture() {
            if (!capIsUsb()) { showToast('Not connected — plug the board in by USB cable', '✕'); return; }
            if (!capNativeFs()) { showToast('File storage unavailable', '✕'); return; }
            // A phone hunting for WiFi keeps sending random-MAC probe requests
            // from right beside the board: the strongest random-MAC device in
            // the capture, which is exactly what a camera at the pole looks
            // like. Android won't let an app switch WiFi off, so ask. A phone
            // connected to WiFi probes far less, so skip the ask then.
            // ponytail: navigator.connection.type can't tell "WiFi off" from
            // "on but not connected", hence "is it off?" as a one-tap confirm.
            // Bluetooth is asked every time: the phones' own BLE adverts (Google
            // FEF3/FCF1 service data) land in every capture, WiFi connected or not.
            const phoneNet = (navigator.connection && navigator.connection.type) || 'unknown';
            const radios = phoneNet === 'wifi' ? 'Bluetooth' : 'WiFi and Bluetooth';
            if (!confirm(
                "Are " + radios + " off on every phone you're carrying?\n\n" +
                "Phones broadcast nonstop and drown out what you're looking for. " +
                "Mobile data is fine.\n\n" +
                "OK: start capturing\nCancel: not yet")) return;
            capFileName = 'signalsweep-capture-' + capStamp() + '.sscap';
            capBuf = '';
            capWriteFailed = false;
            capStat = { wifi: 0, ble: 0, drops: 0, remain: capReqSecs };
            const header = '#SSCAP v1 secs=' + capReqSecs + ' phone_net=' + phoneNet + ' t=' + new Date().toISOString() + '\n';
            try {
                await window.CapFilesystem.writeFile({
                    path: capFileName, data: header,
                    directory: window.CapDirectory.Documents,
                    encoding: window.CapEncoding.UTF8
                });
            } catch (e) {
                showToast('Could not create capture file', '✕');
                return;
            }
            capturing = true;
            capAcquireWake();   // keep the screen on so the OS can't kill the capture
            sendCommand({ raw: 'CMD:CAP:START:' + capReqSecs });
            capArmAck(false);
            capFlushTimer = setInterval(capFlush, 1000);
            showToast('Capturing — keep the board still', '◉');
            paintCapture();
        }

        function stopCaptureManual() {
            if (capturing) sendCommand({ raw: 'CMD:CAP:STOP' });
        }

        function capAppend(b64line) {
            capBuf += b64line + '\n';
            // Flush eagerly if the buffer gets large, so a crash loses little and
            // memory stays bounded in a dense environment.
            if (capBuf.length > 65536) capFlush();
        }
        async function capFlush() {
            if (!capBuf || capWriteFailed) return;
            const chunk = capBuf; capBuf = '';
            try {
                await window.CapFilesystem.appendFile({
                    path: capFileName, data: chunk,
                    directory: window.CapDirectory.Documents,
                    encoding: window.CapEncoding.UTF8
                });
            } catch (e) {
                capWriteFailed = true;
                showToast('Capture write failed — stopping', '✕');
                stopCaptureManual();
            }
        }

        // Start watchdog. A capture once sat at a full countdown with zero
        // counters and a header-only file: the board never answered, and
        // nothing on this side ever gave up. Any {"cap"} frame (the board acks
        // immediately) disarms it; silence gets one resend, then an abort.
        let capAckTimer = null;
        function capArmAck(retried) {
            clearTimeout(capAckTimer);
            capAckTimer = setTimeout(() => {
                if (!capturing) return;
                if (retried) { capAbort("The board didn't start the capture — reconnect and try again", true); return; }
                sendCommand({ raw: 'CMD:CAP:START:' + capReqSecs });
                capArmAck(true);
            }, 5000);
        }

        // End a capture that did not finish normally. deleteFile: the file holds
        // only its header, so keeping it would just add an empty survey.
        async function capAbort(msg, deleteFile) {
            capturing = false;
            clearTimeout(capAckTimer); capAckTimer = null;
            capReleaseWake();
            if (capFlushTimer) { clearInterval(capFlushTimer); capFlushTimer = null; }
            if (deleteFile) {
                capBuf = '';
                try { await window.CapFilesystem.deleteFile({ path: capFileName, directory: window.CapDirectory.Documents }); } catch (e) {}
            } else {
                await capFlush();
            }
            showToast(msg, '✕');
            paintCapture();
            renderFinds();
        }

        function handleCapStat(cap) {
            clearTimeout(capAckTimer); capAckTimer = null;
            if (cap.error) { capAbort('Capture: ' + cap.error, true); return; }
            if ('started' in cap) return;   // ack only
            capStat.wifi = cap.wifi || 0;
            capStat.ble = cap.ble || 0;
            capStat.drops = cap.drops || 0;
            capStat.remain = cap.remain || 0;
            if (cap.done) { capFinish(); return; }
            paintCapture();
        }

        async function capFinish() {
            capturing = false;
            capReleaseWake();
            if (capFlushTimer) { clearInterval(capFlushTimer); capFlushTimer = null; }
            await capFlush();
            let path = capFileName;
            try {
                const { uri } = await window.CapFilesystem.getUri({
                    path: capFileName, directory: window.CapDirectory.Documents
                });
                path = decodeURIComponent(uri).replace(/^file:\/\//, '');
            } catch (e) {}
            const total = capStat.wifi + capStat.ble;
            document.getElementById('cap-summary').textContent =
                total + ' packets (' + capStat.wifi + ' WiFi, ' + capStat.ble + ' BLE)' +
                (capStat.drops > 0 ? ', ' + capStat.drops + ' dropped — the air was busier than USB could carry' : ', none dropped');
            document.getElementById('cap-path').textContent = 'adb pull "' + path + '"';
            // Analyze the capture we just wrote, on the phone, and surface the
            // suspect signature. This is the "signature finder".
            lastAnalysis = null;
            try {
                const r = await window.CapFilesystem.readFile({
                    path: capFileName, directory: window.CapDirectory.Documents, encoding: window.CapEncoding.UTF8
                });
                lastAnalysis = analyzeCaptureText(r.data);
            } catch (e) {}
            paintAnalysis();
            document.getElementById('cap-idle').style.display = 'none';
            document.getElementById('cap-running').style.display = 'none';
            document.getElementById('cap-done').style.display = 'block';
            renderFinds();
            showToast(lastAnalysis && lastAnalysis.flockDetected ? '⚠ Flock signature detected' : 'Capture saved',
                      lastAnalysis && lastAnalysis.flockDetected ? '⚠' : '✓');
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
        // Which band asks to be pinned. App-side, because pins are: looking
        // for Flock cameras should not mean being asked about every AirTag.
        // A band tab sets it; the Pins sheet can override it.
        let pinLens = 'all';
        try { pinLens = localStorage.getItem('pinLens') || 'all'; } catch (e) {}
        let pinKey = null;            // CryptoKey, set once unlocked this session
        let pinSalt = null;            // Uint8Array, persisted with the store
        let pinsCache = [];            // decrypted pins, in memory only while unlocked
        let findsCache = [];           // decrypted investigation "finds" (Finder page)
        const handledMacs = new Set(); // asked-or-recorded this session (no re-prompt)
        let consentQueue = [];         // pending {match}

        // Chunked: spreading a whole photo into fromCharCode overflows the call
        // stack from ~0.5 MB up, which silently lost every logged photo.
        function b64(bytes) {
            const u = new Uint8Array(bytes);
            let s = '';
            for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
            return btoa(s);
        }
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

        // Persists the whole encrypted store. v2 holds BOTH the simple location
        // pins and the richer investigation "finds" (signature + photo + capture)
        // in one AES-GCM blob under one PIN. (Name kept: it saves the store.)
        async function savePins() {
            if (!pinKey || !pinSalt) return;
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const enc = new TextEncoder();
            const body = JSON.stringify({ pins: pinsCache, finds: findsCache });
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, pinKey, enc.encode(body));
            const payload = { v: 2, salt: b64(pinSalt), iv: b64(iv), ct: b64(ct) };
            try { localStorage.setItem(PIN_STORE_KEY, JSON.stringify(payload)); }
            catch (e) { showToast('Could not save', '✕'); }
        }

        // Create a brand-new store with this PIN (first time recording).
        async function createPinStore(pin) {
            pinSalt = crypto.getRandomValues(new Uint8Array(16));
            pinKey = await deriveKey(pin, pinSalt);
            pinsCache = [];
            findsCache = [];
            await savePins();
        }

        // Unlock an existing store. Throws if the PIN is wrong (GCM auth fails).
        async function unlockPins(pin) {
            const raw = JSON.parse(localStorage.getItem(PIN_STORE_KEY));
            const salt = unb64(raw.salt), iv = unb64(raw.iv), ct = unb64(raw.ct);
            const key = await deriveKey(pin, salt);
            const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); // throws on bad PIN
            const obj = JSON.parse(new TextDecoder().decode(dec));
            // v1 stored a bare pins array; v2 stores {pins, finds}. Migrate.
            if (Array.isArray(obj)) { pinsCache = obj; findsCache = []; }
            else { pinsCache = obj.pins || []; findsCache = obj.finds || []; }
            pinKey = key; pinSalt = salt;
        }

        function wipePins() {
            try { localStorage.removeItem(PIN_STORE_KEY); } catch (e) {}
            pinKey = null; pinSalt = null; pinsCache = []; findsCache = [];
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
                case 'sysoff':   return { dot: 'bad',  text: 'Location is off' };
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

        // Which board this is and how long it has been up. Name comes from
        // CMD:CFG, because over a cable all you would otherwise see is a port.
        // Uptime is asked once and counted on here; the alert count rides the
        // push. All three belong to one board and are cleared on disconnect.
        let devName = '';
        let bootAt = null;
        let alertCount = null;

        // The header's connection bar button. It is a labelled button, not a
        // tappable name: a glyph on the name line was a control nobody would
        // find. Disconnecting asks first, since it sits under a thumb.
        function hdrTap() {
            if (!connectionType) { openConnModal(); return; }
            if (confirm('Disconnect from ' + (devName || 'the device') + '?\n\n' +
                        'It keeps scanning and beeping on its own.')) disconnectDevice();
        }

        function fmtUptime(s) {
            if (s < 60) return s + 's';
            const m = Math.floor(s / 60);
            if (m < 60) return m + 'm';
            const h = Math.floor(m / 60);
            if (h < 24) return h + 'h ' + (m % 60) + 'm';
            return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
        }

        function renderStatusStrip() {
            const set = (dotId, textId, cls, text) => {
                const d = document.getElementById(dotId);
                const t = document.getElementById(textId);
                if (d) d.className = 'statdot ' + cls;
                if (t) t.textContent = text;
            };
            // Short forms: the name, the uptime and the alert count share one
            // line with the Disconnect button, and "Bluetooth" alone cost
            // enough of it to ellipsize the board's own name.
            const via = { BLE: 'BLE', USB: 'USB', SERIAL: 'Serial' }[connectionType] || connectionType;
            set('hdr-dot', 'hdr-dev',
                connectionType ? 'ok' : 'off',
                !connectionType ? 'Not connected'
                    : devName ? devName + ' · ' + via : via);
            const act = document.getElementById('hdr-act');
            if (act) {
                act.textContent = connectionType ? 'Disconnect' : 'Connect';
                act.classList.toggle('disc', !!connectionType);
            }
            // Uptime and the alert count ride the same line as the board name.
            // Both are how you prove the headless path worked, so they stay on
            // Sweep; they just no longer need a card to say it.
            const bits = [];
            if (bootAt !== null) bits.push(fmtUptime(Math.max(0, Math.floor((Date.now() - bootAt) / 1000))));
            if (alertCount !== null) bits.push(alertCount + (alertCount === 1 ? ' alert' : ' alerts'));
            const st = document.getElementById('hdr-stats');
            if (st) st.textContent = bits.length ? ' · ' + bits.join(' · ') : '';
            // The GPS readout appears only while there is something to say.
            // Idle it read "Location: Off" forever and owned a third of a card.
            const g = gpsDisplay();
            const gw = document.getElementById('hdr-gps');
            if (gw) gw.hidden = (gpsState.state === 'off');
            set('st-gps-dot', 'st-gps', g.dot, g.text);
            // Here rather than only on a change: a reconnect whose scan_all
            // matches the old value would otherwise leave "—" up.
            paintFilter();
            // The Record bar's elapsed time and counters ride the same 1 Hz
            // push rather than a timer of their own.
            paintLogSession();
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
                    // Location switched off system-wide used to read as a cold
                    // lock: "Locating..." then "No fix", which sends you outside
                    // to wait for a fix that can never come. Say so and open the
                    // switch instead.
                    const native = window.Capacitor && window.Capacitor.isNativePlatform() && window.BleClient;
                    (native ? window.BleClient.isLocationEnabled() : Promise.resolve(true))
                        .catch(() => true)
                        .then((on) => {
                            if (on) {
                                return window.Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 })
                                    .then(done, failed);
                            }
                            setGpsState('sysoff');
                            showToast('Location is off. Turn it on, then try again.', '⚠');
                            window.BleClient.openLocationSettings().catch(() => {});
                            reject(new Error('Location is off'));
                        });
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
            try { localStorage.setItem(RECORD_PREF_KEY, recordEnabled ? '1' : '0'); } catch (e) {}
            paintRecord();
            showToast(recordEnabled ? 'Will ask to pin each match' : 'Not asking to pin', '📍');
        }

        // The switch lives in Settings > Recording. While a recording is
        // running the Record bar on Sweep is what says the prompt is armed.
        function paintRecord() {
            const btn = document.getElementById('btn-record');
            if (btn) {
                btn.classList.toggle('on', recordEnabled);
                btn.textContent = recordEnabled ? 'On' : 'Off';
            }
        }

        // Which categories ask to be pinned. There is no separate picker for
        // it any more: the band tab you are looking at is the one you are
        // deciding about, and two controls for one state only ever disagree.
        // The Record bar states the current one.
        function setPinLens(key) {
            pinLens = key;
            try { localStorage.setItem('pinLens', key); } catch (e) {}
            paintLogSession();
        }

        function maybeOfferRecord(match) {
            if (!recordEnabled) return;
            // With the filter off the device reports everything it hears, and
            // without this the app would ask permission to pin every phone on
            // the street. Pins are for things that actually matched.
            if (!match.type && !match.rule) return;
            // Before handledMacs, so a device the filter skipped is still
            // offered if the filter widens later.
            if (!inLens(match, pinLens)) return;
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
            paintLogSession();
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
            document.getElementById('pin-gate-submit').textContent =
                mode === 'create' ? 'Set PIN' : 'Unlock';
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
        // Pins live in the Survey tab beside the logged finds: same encrypted
        // store, same PIN, same kind of record. Opening the tab never prompts
        // for the PIN -- only "Unlock to view" does.
        function openPins() { showTab('survey'); }
        function unlockPinsView() {
            pendingPinAction = () => { renderPins(); renderFinds(); };
            openPinGate('unlock');
        }
        function renderPins() {
            const body = document.getElementById('pins-body');
            if (!body) return;
            if (!pinKey && pinStoreExists()) {
                body.innerHTML = '<div class="scope-empty">Saved pins are locked.<br>' +
                    '<button class="ctrl-btn" style="margin-top:0.7rem" onclick="unlockPinsView()">Unlock to view</button></div>';
                return;
            }
            if (pinsCache.length === 0) {
                body.innerHTML = '<div class="scope-empty">No pins yet. Turn on <strong>Ask to pin matches</strong> and confirm a device to drop one.</div>';
            } else {
                body.innerHTML = pinsCache.map((p, i) => {
                    const cat = categoryOf(p.category);
                    return '<div class="scope-row" style="border-left:4px solid ' + cat.color + '">' +
                        '<div class="scope-main">' +
                            '<div class="scope-title">' + cat.icon + ' ' + esc(p.category) + (p.photo ? ' 📷' : '') + '</div>' +
                            '<div class="scope-sub">' + esc(p.mac || (p.source === 'camera-log' ? 'photo log' : '')) + ' · ' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) +
                                ' · ±' + Math.round(p.acc) + 'm · ' + new Date(p.ts).toLocaleString() + '</div>' +
                        '</div>' +
                        '<button class="scope-del" onclick="deletePin(' + i + ')">✕</button>' +
                    '</div>';
                }).join('');
            }
        }
        async function deletePin(i) {
            pinsCache.splice(i, 1);
            await savePins();
            renderPins();
        }
        // One store, one key: this takes the logged finds and their photos too.
        function wipePinsConfirm() {
            if (!confirm('Delete every saved pin and logged find permanently? This cannot be undone.')) return;
            wipePins();
            renderPins();
            renderFinds();
            showToast('Everything saved was wiped', '🗑');
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
        //  Camera evidence: a photo + GPS pin of a surveillance camera.
        // =====================================================================
        // Triggered from the capture-done screen so the photo and GPS are tied
        // to that camera's packet capture. The photo is encrypted with the SAME
        // PIN key as the pins (AES-GCM, its own IV) and stored as a file --
        // photos are far too big for the localStorage pin blob. Both the pin
        // index and the photo are ciphertext; nothing readable is written by us.
        // (The OS camera keeps its own temp copy of the shot -- we encrypt what
        // we store, we can't scrub the OS cache. The button says so.)
        async function encryptBytes(bytes) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, pinKey, bytes);
            const out = new Uint8Array(12 + ct.byteLength);
            out.set(iv, 0);
            out.set(new Uint8Array(ct), 12);
            return out;
        }
        async function decryptBytes(buf) {
            const iv = buf.slice(0, 12), ct = buf.slice(12);
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, pinKey, ct);
            return new Uint8Array(pt);
        }

        // Run cb once the pin store is unlocked. Reuses the PIN gate: unlock an
        // existing store, or create one on first use.
        function ensurePinUnlocked(cb) {
            if (pinKey) { cb(); return; }
            pendingPinAction = cb;
            openPinGate(pinStoreExists() ? 'unlock' : 'create');
        }

        // The analysis of the most recent capture, so "Log this device" can
        // auto-attach the detected signature.
        let lastAnalysis = null;

        // On-phone port of analyze-capture.py's core: parse the .sscap records,
        // walk 802.11 IEs, and find devices carrying the exact Flock fingerprint
        // 50:6f:9a:16:03:01:03. Returns a suspect + a signature to attach.
        // The firmware's Flock OUI list (mode_watchers_watch.cpp flockOuis[]).
        // selftest.js fails if the two drift. The analyzer calls a capture Flock
        // only under the detector's own rule: one of these OUIs + a wildcard
        // probe + the IE. The IE alone rides consumer WiFi (a China Dragon
        // module at the bench), so on any other MAC it says nothing.
        const FLOCK_OUIS = [
            "b4:1e:52", "70:c9:4e", "3c:91:80", "d8:f3:bc", "80:30:49", "b8:35:32",
            "14:5a:fc", "74:4c:a1", "08:3a:88", "9c:2f:9d", "c0:35:32", "94:08:53",
            "e4:aa:ea", "f4:6a:dd", "24:b2:b9", "00:f4:8d", "d0:39:57",
            "e8:d0:fc", "e0:4f:43", "b8:1e:a4", "70:08:94", "58:8e:81", "ec:1b:bd",
            "58:00:e3", "90:35:ea", "5c:93:a2", "64:6e:69", "48:27:ea", "14:b5:cd",
            "04:0d:84", "1c:34:f1", "38:5b:44", "94:34:69",
            "b4:e3:f9", "f0:82:c0", "e0:0a:f6"
        ];
        const FLOCK_OUI_SET = new Set(FLOCK_OUIS);
        function analyzeCaptureText(text) {
            const FLOCK = [0x50, 0x6f, 0x9a, 0x16, 0x03, 0x01, 0x03];
            let wifi = 0, ble = 0, strongest = null, n = 0;
            const flock = {};   // mac -> {rssi, count, random, ssid}
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (!t || t[0] === '#') continue;
                // Bound the work: a 10-min dense capture is ~30k records; this cap
                // can't truncate a real one but stops a pathological file freezing
                // the UI. The Flock IE rides every probe, so a cap never misses it.
                if (++n > 60000) break;
                let rec;
                try { rec = unb64(t); } catch (e) { continue; }
                if (rec.length < 15) continue;
                const radio = rec[0];
                const rssi = (rec[10] << 24) >> 24;              // int8
                const capLen = rec[13] | (rec[14] << 8);
                const payload = rec.subarray(15, 15 + capLen);
                if (radio === 1) { ble++; continue; }
                wifi++;
                if (payload.length < 24) continue;
                const fc0 = payload[0];
                if (((fc0 >> 2) & 3) !== 0) continue;            // mgmt only
                const fsub = (fc0 >> 4) & 0xf;
                const a2 = Array.from(payload.subarray(10, 16));
                const mac = a2.map(b => b.toString(16).padStart(2, '0')).join(':');
                const random = !!(a2[0] & 0x02);
                if (!strongest || rssi > strongest.rssi) strongest = { mac, rssi, random };
                let i = fsub === 4 ? 24 : 36, ssid = null, hasFlock = false, wildcard = false;
                while (i + 2 <= payload.length) {
                    const id = payload[i], ln = payload[i + 1];
                    if (i + 2 + ln > payload.length) break;
                    if (id === 0 && ln > 0) { try { ssid = new TextDecoder().decode(payload.subarray(i + 2, i + 2 + ln)); } catch (e) {} }
                    if (id === 0 && ln === 0 && fsub === 4) wildcard = true;
                    if (id === 221 && ln === 7) {
                        let m = true;
                        for (let k = 0; k < 7; k++) if (payload[i + 2 + k] !== FLOCK[k]) { m = false; break; }
                        if (m) hasFlock = true;
                    }
                    i += 2 + ln;
                }
                // The detector's rule, exactly: listed Flock OUI + wildcard + IE.
                if (hasFlock && wildcard && FLOCK_OUI_SET.has(mac.slice(0, 8))) {
                    const f = flock[mac] || (flock[mac] = { rssi: -999, count: 0, random, ssid: null });
                    f.rssi = Math.max(f.rssi, rssi); f.count++;
                    if (ssid) f.ssid = ssid;
                }
            }
            const list = Object.entries(flock).map(([mac, f]) => ({ mac, ...f })).sort((a, b) => b.rssi - a.rssi);
            const randomN = list.filter(f => f.random).length;
            return {
                wifi, ble,
                flockDetected: list.length > 0,
                flockMacs: list.length, flockRandom: randomN,
                flockStrongest: list.length ? list[0].rssi : null,
                suspect: list[0] || strongest,
                signature: list.length > 0
                    ? { type: 'flock-ie', label: 'Flock probe + IE (listed Flock OUI)',
                        macs: list.length, randomMacs: randomN, rssi: list[0].rssi, sampleMac: list[0].mac }
                    : (strongest ? { type: 'strongest', label: 'strongest device (no Flock signature)',
                        rssi: strongest.rssi, sampleMac: strongest.mac, random: strongest.random } : null)
            };
        }

        function paintAnalysis() {
            const el = document.getElementById('cap-analysis');
            if (!el) return;
            const a = lastAnalysis;
            if (!a) { el.innerHTML = ''; return; }
            if (a.flockDetected) {
                // Only ever the detector's own rule (listed Flock OUI + wildcard
                // probe + IE), so the phone never cries wolf where the board wouldn't.
                el.innerHTML = '<div style="color:var(--accent-red,#ef4444);font-weight:700;font-size:1.05rem;">⚠ Flock signature</div>' +
                    '<p class="set-note">' + a.flockMacs + ' device(s) on a known Flock MAC prefix sending wildcard probes with the Flock IE, ' +
                    'strongest <strong>' + a.flockStrongest + ' dBm</strong>. This is the same rule the detector beeps on.</p>';
            } else {
                el.innerHTML = '<p class="set-note">No Flock signature in this capture. Strongest device: ' +
                    (a.suspect ? esc(a.suspect.mac) + ' at ' + a.suspect.rssi + ' dBm' : 'none') +
                    '. If you were next to a camera and see nothing, it may be on cellular, which no SignalSweep board hears, or on 5 GHz, which only the XIAO ESP32-C5 hears. You can still log the device.</p>';
            }
        }

        // Log a device to the encrypted finds database. Photo-survives-GPS: the
        // photo is saved and the find is created FIRST; GPS is filled in after,
        // so a slow fix in the field never throws away a good shot.
        // category is the operator's call, from the picker: 'ALPR / Camera',
        // 'Surveillance Camera' or 'Unconfirmed'. Only the first two export as
        // map points (findOsmNode).
        async function logDevice(category) {
            category = category || 'Unconfirmed';
            if (!window.Camera || !capNativeFs()) { showToast('Camera unavailable on this platform', '✕'); return; }
            ensurePinUnlocked(async () => {
                const sig = lastAnalysis && lastAnalysis.signature ? lastAnalysis.signature : null;
                // Android can kill the app while the camera is in front, and the
                // photo then comes back through appRestoredResult to a fresh app
                // that has lost lastAnalysis and the PIN key. Stash what the find
                // needs; the capture file beside it is already plaintext on disk.
                try { localStorage.setItem(PENDING_FIND_KEY, JSON.stringify({ sig: sig, capture: capFileName || null, category: category })); } catch (e) {}
                let shot;
                try {
                    shot = await window.Camera.getPhoto({ quality: 70, allowEditing: false, resultType: 'base64', source: 'CAMERA', saveToGallery: false });
                } catch (e) { showToast('Photo cancelled', '…'); return; }
                if (!shot || !shot.base64String) { showToast('No photo taken', '✕'); return; }
                await saveFindFromShot(shot.base64String, sig, capFileName || null, category);
            });
        }

        const PENDING_FIND_KEY = 'pendingFind';
        async function saveFindFromShot(base64, sig, capture, category) {
                let photoName = null;
                try {
                    const enc = await encryptBytes(unb64(base64));
                    photoName = 'signalsweep-photos/dev-' + Date.now() + '.enc';
                    await window.CapFilesystem.writeFile({ path: photoName, data: b64(enc), directory: window.CapDirectory.Documents, recursive: true });
                } catch (e) { showToast('Could not save the photo', '✕'); return; }
                const find = {
                    id: 'f' + Date.now(), ts: Date.now(),
                    category: category || 'Unconfirmed', label: '',
                    signature: sig, photo: photoName, capture: capture,
                    lat: null, lng: null, acc: null
                };
                findsCache.push(find);
                await savePins();
                try { localStorage.removeItem(PENDING_FIND_KEY); } catch (e) {}
                renderFinds();
                showToast('Device logged — getting GPS…', '📷');
                // GPS in the background; the find is already saved.
                try {
                    const fix = await getFix();
                    find.lat = fix.lat; find.lng = fix.lng; find.acc = fix.acc;
                    await savePins();
                    renderFinds();
                    showToast('Location added (±' + Math.round(fix.acc) + 'm)', '📍');
                } catch (e) {
                    showToast('Saved without GPS — add location later', '⚠');
                }
        }

        // The other half of the camera round-trip: Android restarted the app
        // while the camera was open, so getPhoto()'s promise died with the old
        // page and the shot arrives here instead. Without this the photo was
        // silently dropped and the log stayed empty.
        if (window.App && window.App.addListener) {
            window.App.addListener('appRestoredResult', (r) => {
                if (!r || r.pluginId !== 'Camera' || !r.success || !r.data || !r.data.base64String) return;
                let ctx = {};
                try { ctx = JSON.parse(localStorage.getItem(PENDING_FIND_KEY)) || {}; } catch (e) {}
                openFinder();
                showToast('Android restarted the app — unlock to save the photo', '📷');
                ensurePinUnlocked(() => saveFindFromShot(r.data.base64String, ctx.sig || null, ctx.capture || null, ctx.category || 'Unconfirmed'));
            });
        }

        // Full evidence bundle for DeFlock verification: decrypt photos, write
        // coordinates (OSM + CSV), and copy the linked packet captures into one
        // folder, then report where it landed.
        // Full evidence bundle for DeFlock: decrypt each find's photo, write
        // coordinates + signature (OSM + CSV), and copy the linked raw captures
        // into one folder. A find with no GPS yet still exports photo + signature
        // + capture -- just no OSM node.
        // Only a camera the operator confirmed becomes a map point. A "Not sure"
        // photo in cameras.osm would put a surveillance node on OpenStreetMap on
        // a guess; it stays in the CSV and the log instead.
        const FIND_OSM_TYPE = { 'ALPR / Camera': 'ALPR', 'Surveillance Camera': 'camera' };
        function findOsmNode(f, i, sigLabel, photoOut) {
            const type = FIND_OSM_TYPE[f.category];
            if (!type || f.lat == null) return '';
            return '  <node id="-' + (i + 1) + '" lat="' + f.lat.toFixed(7) + '" lon="' + f.lng.toFixed(7) + '">\n' +
                   '    <tag k="man_made" v="surveillance"/>\n' +
                   '    <tag k="surveillance:type" v="' + type + '"/>\n' +
                   '    <tag k="signalsweep:category" v="' + xmlAttr(f.category) + '"/>\n' +
                   '    <tag k="signalsweep:signature" v="' + xmlAttr(sigLabel) + '"/>\n' +
                   (photoOut ? '    <tag k="signalsweep:photo" v="' + photoOut + '"/>\n' : '') +
                   '  </node>\n';
        }
        async function exportEvidenceBundle() {
            if (!capNativeFs()) { showToast('File storage unavailable', '✕'); return; }
            ensurePinUnlocked(async () => {
                if (!findsCache.length) { showToast('Nothing to export yet — tap a survey, then 📷 Log this device', 'ℹ'); return; }
                const dir = 'signalsweep-evidence-' + capStamp();
                const D = window.CapDirectory.Documents, U = window.CapEncoding.UTF8;
                let csv = 'ts,lat,lng,acc_m,category,signature,sample_mac,photo,capture\n';
                let osm = '<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="SignalSweep">\n';
                let photos = 0, caps = 0;
                for (let i = 0; i < findsCache.length; i++) {
                    const f = findsCache[i];
                    const photoOut = f.photo ? 'photo-' + i + '.jpg' : '';
                    const sigLabel = f.signature ? f.signature.label : '';
                    const sampleMac = f.signature ? (f.signature.sampleMac || '') : '';
                    csv += [f.ts, f.lat != null ? f.lat : '', f.lng != null ? f.lng : '',
                            f.acc != null ? Math.round(f.acc) : '', '"' + (f.category || '') + '"',
                            '"' + sigLabel + '"', sampleMac, photoOut, f.capture || ''].join(',') + '\n';
                    osm += findOsmNode(f, i, sigLabel, photoOut);
                    if (f.photo) {
                        try {
                            const r = await window.CapFilesystem.readFile({ path: f.photo, directory: D });
                            const pt = await decryptBytes(unb64(r.data));
                            await window.CapFilesystem.writeFile({ path: dir + '/' + photoOut, data: b64(pt), directory: D, recursive: true });
                            photos++;
                        } catch (e) {}
                    }
                    if (f.capture) {
                        try {
                            const c = await window.CapFilesystem.readFile({ path: f.capture, directory: D, encoding: U });
                            await window.CapFilesystem.writeFile({ path: dir + '/' + f.capture, data: c.data, directory: D, encoding: U, recursive: true });
                            caps++;
                        } catch (e) {}
                    }
                }
                osm += '</osm>\n';
                await window.CapFilesystem.writeFile({ path: dir + '/cameras.csv', data: csv, directory: D, encoding: U, recursive: true });
                await window.CapFilesystem.writeFile({ path: dir + '/cameras.osm', data: osm, directory: D, encoding: U, recursive: true });
                showToast(findsCache.length + ' finds · ' + photos + ' photos → Documents/' + dir, '✓');
            });
        }

        // ---- The Survey tab (investigation workflow) ----
        // openFinder/closeFinder keep their names: they are what the capture
        // flow and the onclicks already call, and they now just move tabs.
        function openFinder() { showTab('survey'); }
        function closeFinder() { showTab('sweep'); }
        function unlockFindsView() {
            pendingPinAction = renderFinds;
            openPinGate(pinStoreExists() ? 'unlock' : 'create');
        }
        // Every capture on the phone is a survey. The list reads the .sscap files
        // themselves, so viewing needs no PIN and keeps no second history.
        // ponytail: verdicts are computed on tap, not per row; analyzing every
        // capture on each render would stall the page once there are a few.
        async function listSurveys() {
            if (!capNativeFs()) return [];
            try {
                const r = await window.CapFilesystem.readdir({ path: '', directory: window.CapDirectory.Documents });
                return r.files.map(f => typeof f === 'string' ? { name: f } : f)
                    .filter(f => /^signalsweep-capture-\d{8}-\d{6}\.sscap$/.test(f.name))
                    .sort((a, b) => b.name.localeCompare(a.name));
            } catch (e) { return []; }
        }
        function surveyWhen(name) {
            const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
            return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toLocaleString() : name;
        }
        async function renderFinds() {
            const el = document.getElementById('finds-list');
            const cnt = document.getElementById('finds-count');
            if (!el) return;
            const surveys = await listSurveys();
            const locked = !pinKey && pinStoreExists();
            if (cnt) cnt.textContent = surveys.length;
            const byCap = {};
            if (!locked) findsCache.forEach((f, i) => { (byCap[f.capture] = byCap[f.capture] || []).push(i); });
            const photoLine = i => {
                const f = findsCache[i];
                const loc = f.lat != null ? f.lat.toFixed(5) + ', ' + f.lng.toFixed(5) + ' · ±' + Math.round(f.acc) + 'm' : '⚠ no location yet';
                return '<div class="scope-sub">📷 ' + loc + ' · <a href="#" onclick="event.stopPropagation();deleteFind(' + i + ');return false">remove</a></div>';
            };
            let html = locked
                ? '<div class="scope-empty">Photos and locations are locked. ' +
                  '<button class="ctrl-btn" style="margin-top:0.5rem" onclick="unlockFindsView()">Unlock</button></div>'
                : '';
            html += surveys.map(s => {
                const mine = byCap[s.name] || [];
                return '<div class="scope-row" style="border-left:4px solid var(--accent-cyan)">' +
                    '<div class="scope-main" data-survey="' + esc(s.name) + '" style="cursor:pointer">' +
                        '<div class="scope-title">📡 ' + esc(surveyWhen(s.name)) + (mine.length ? ' · 📷 ' + mine.length : '') + '</div>' +
                        '<div class="scope-sub">' + (s.size ? Math.round(s.size / 1024) + ' KB · ' : '') + 'tap to analyze</div>' +
                        mine.map(photoLine).join('') +
                    '</div>' +
                    '<button class="scope-del" data-del-survey="' + esc(s.name) + '" aria-label="Delete survey">✕</button>' +
                '</div>';
            }).join('');
            // Logged photos whose capture is gone (deleted, or logged without one).
            const orphans = locked ? [] : findsCache.map((f, i) => i).filter(i => !surveys.some(s => s.name === findsCache[i].capture));
            if (!surveys.length && !orphans.length) {
                el.innerHTML = html + '<div class="scope-empty">No surveys yet. Capture an environment above.</div>';
                return;
            }
            el.innerHTML = html + orphans.map(i => findsCache[i]).map((f, k) => {
                const i = orphans[k];
                const cat = categoryOf(f.category);
                const loc = (f.lat != null)
                    ? (f.lat.toFixed(5) + ', ' + f.lng.toFixed(5) + ' · ±' + Math.round(f.acc) + 'm')
                    : '⚠ no location yet';
                const sig = f.signature
                    ? esc(f.signature.label) + (f.signature.randomMacs ? ' · ' + f.signature.randomMacs + ' random MACs' : '')
                    : 'no signature';
                return '<div class="scope-row" style="border-left:4px solid ' + cat.color + '">' +
                    '<div class="scope-main">' +
                        '<div class="scope-title">' + cat.icon + ' ' + esc(f.category) + (f.photo ? ' 📷' : '') + '</div>' +
                        '<div class="scope-sub">' + sig + '<br>' + loc + ' · ' + new Date(f.ts).toLocaleString() + '</div>' +
                    '</div>' +
                    '<button class="scope-del" onclick="deleteFind(' + i + ')">✕</button>' +
                '</div>';
            }).join('');
        }
        // Reopen a saved survey: analyze it again and show the finished-capture
        // panel, so Log this device attaches the photo to THIS capture.
        async function openSurvey(name) {
            if (capturing) { showToast('Finish the running capture first', '…'); return; }
            try {
                const r = await window.CapFilesystem.readFile({ path: name, directory: window.CapDirectory.Documents, encoding: window.CapEncoding.UTF8 });
                lastAnalysis = analyzeCaptureText(r.data);
            } catch (e) { showToast('Could not read that survey', '✕'); return; }
            capFileName = name;
            document.getElementById('cap-summary').textContent = surveyWhen(name) + ' · ' +
                (lastAnalysis.wifi + lastAnalysis.ble) + ' packets (' + lastAnalysis.wifi + ' WiFi, ' + lastAnalysis.ble + ' BLE)';
            document.getElementById('cap-path').textContent = 'adb pull "/sdcard/Documents/' + name + '"';
            paintAnalysis();
            document.getElementById('cap-idle').style.display = 'none';
            document.getElementById('cap-running').style.display = 'none';
            document.getElementById('cap-done').style.display = 'block';
            document.getElementById('cap-done').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        async function deleteSurvey(name) {
            if (!confirm('Delete this survey capture from the phone? Logged photos stay in the log.')) return;
            try { await window.CapFilesystem.deleteFile({ path: name, directory: window.CapDirectory.Documents }); }
            catch (e) { showToast('Could not delete that survey', '✕'); return; }
            if (capFileName === name) closeCapture(); else renderFinds();
        }
        // Survey file names ride data- attributes with one delegated listener.
        document.addEventListener('click', (e) => {
            const open = e.target.closest('[data-survey]');
            if (open) { openSurvey(open.dataset.survey); return; }
            const del = e.target.closest('[data-del-survey]');
            if (del) deleteSurvey(del.dataset.delSurvey);
        });
        function deleteFind(i) {
            const f = findsCache[i];
            if (f && f.photo && window.CapFilesystem) {
                try { window.CapFilesystem.deleteFile({ path: f.photo, directory: window.CapDirectory.Documents }); } catch (e) {}
            }
            findsCache.splice(i, 1);
            savePins();
            renderFinds();
        }

        // =====================================================================
        //  Alarm tuning + signature editor (device commands)
        // =====================================================================
        // Null until the device tells us. The mute persists on the board, so a
        // detector muted in the field comes back muted -- an app that assumed
        // ON would show a lie, and with two boards around it would show the
        // wrong board's lie. Painted only from CMD:CFG, like the radios.
        let buzzerOn = null;
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
            if (typeof cfg.attack === 'boolean') setAttackUi(cfg.attack);
            if (typeof cfg.beep_mask === 'number') setBeepUi(cfg.beep_mask);
            setBuzzerUi(cfg.buzzer);
            setLedUi(cfg.led);
            setThemeUi(cfg.theme);
            setBandUi(cfg.band);
            devName = (typeof cfg.ble_name === 'string' && cfg.ble_name) || 'SignalSweep';
            if (typeof cfg.uptime === 'number') bootAt = Date.now() - cfg.uptime * 1000;
            // Alert log. log_boot/log_secs are the board's current ordering key:
            // the bookmark a session starts from, and the only way to date
            // records later -- the board has no clock, so this is the one moment
            // a boot can be tied to real time.
            if (typeof cfg.log_n === 'number') logHeld = cfg.log_n;
            if (typeof cfg.log_boot === 'number') logBootNow = cfg.log_boot;
            if (typeof cfg.log_secs === 'number') logSecsNow = cfg.log_secs;
            noteBootEpoch(logBootNow, logSecsNow);
            if (typeof cfg.log === 'boolean') setLogUi(cfg.log);
            renderStatusStrip();
        }

        // Which categories the buzzer is allowed to speak. One bit per firmware
        // AlertCategory -- this bit order IS the contract with
        // hardware_manager.h's enum; change one, change both.
        const BEEP_BITS = { alpr: 1, bodycam: 2, drone: 4, tracker: 8, generic: 16 };

        // The mask each band tab sets. Cameras is the same set inLens() uses:
        // ALPR + body cam, never GENERIC (that is Everything only).
        const LENS_MASK = {
            all:     31,
            alpr:    BEEP_BITS.alpr | BEEP_BITS.bodycam,
            tracker: BEEP_BITS.tracker,
            drone:   BEEP_BITS.drone
        };
        // The tab a mask corresponds to, or null for a custom mix from the
        // Alerts sheet (the tab then stays where it is).
        function lensOfMask(mask) {
            for (const k in LENS_MASK) if (LENS_MASK[k] === mask) return k;
            return null;
        }

        // Device is the authority, same as the radios: the boxes paint from the
        // last CMD:CFG, never optimistically. The mask persists on the board, so
        // one that ran headless comes back with its own idea of what beeps.
        // The last mask the DEVICE confirmed, null until it tells us. Every
        // toggle is computed from this, never from the DOM -- that is the whole
        // fix. These rows used to be <input type="checkbox">, and a checkbox
        // flips itself on tap before any write is even attempted, so a rejected
        // or dropped write left the box showing a mask the board did not have,
        // for the rest of the session, with nothing on screen to say so.
        let deviceBeepMask = null;
        // What we have asked the device for but have not yet seen echoed back.
        // Toggles chain off this so a second tap inside the ~1 s echo window
        // builds on the first instead of overwriting it -- computing every tap
        // from the last CONFIRMED mask silently discarded the earlier one
        // (measured on the bench: five quick taps that should have muted
        // everything left two categories still sounding). This decides only
        // what the next command asks for; the rows still paint from the device.
        let pendingMask = null;
        let pendingSince = 0;
        // A write that never lands must not leave a phantom for later taps to
        // build on, so intent expires and the next tap resyncs to the truth.
        const PENDING_TTL_MS = 3000;

        function setBeepUi(mask) {
            if (pendingMask !== null &&
                (mask === pendingMask || Date.now() - pendingSince > PENDING_TTL_MS)) {
                pendingMask = null;
            }
            if (typeof mask !== 'number') pendingMask = null;
            deviceBeepMask = (typeof mask === 'number') ? mask : null;
            for (const key in BEEP_BITS) {
                const el = document.getElementById('beep-' + key);
                if (el) el.classList.remove('pending');
            }
            paintAlertRows();
            setSoundsSummary();
            // Adopt the board's tab. This is what makes a board set headless
            // (or from another phone) open on the right tab. It follows what
            // we asked for while that is in flight, so the echo gap cannot
            // flip a fresh tap back.
            const k = lensOfMask(pendingMask !== null ? pendingMask : deviceBeepMask);
            if (k && k !== lens) { paintLens(k); setPinLens(k); }
        }

        // Flip one bit off the device-confirmed mask and send the whole mask.
        // No optimistic paint and no success toast: the acknowledgement is the
        // next frame from the device, which the 1 Hz echo guarantees is under a
        // second away. If the write never lands, that frame repaints the old
        // value and the row goes back on its own -- self-healing, with
        // sendCommand's own transport error toast saying why.
        function toggleBeep(key) {
            const base = pendingMask !== null ? pendingMask : deviceBeepMask;
            if (base === null) { showToast('Waiting for the device', '…'); return; }
            const bit = BEEP_BITS[key];
            if (!bit) return;
            pendingMask = base ^ bit;
            pendingSince = Date.now();
            const el = document.getElementById('beep-' + key);
            if (el) el.classList.add('pending');
            sendCommand({ beep_mask: pendingMask });
        }

        // What one category's alert will actually do, given the two outputs.
        // The buzzer mute is sound only and a category switch gates both its
        // beep and its light, so a bare ON/OFF lied both ways -- that is how
        // "Buzzer: OFF" sat above five rows still reading ON. Outputs not yet
        // reported (null; older firmware has no LED mode) count as on.
        function alertChip(on, sound, led) {
            if (on === null) return '—';
            if (!on) return 'Off';
            const s = sound !== false, l = led !== 0;
            return s && l ? '🔊 💡' : s ? '🔊' : l ? '💡' : 'Silent';
        }
        function paintAlertRows() {
            for (const key in BEEP_BITS) {
                const el = document.getElementById('beep-' + key);
                if (!el) continue;
                const on = deviceBeepMask === null ? null : (deviceBeepMask & BEEP_BITS[key]) !== 0;
                const chip = alertChip(on, buzzerOn, ledMode);
                el.dataset.on = on === null ? '' : (on ? '1' : '0');
                el.classList.toggle('on', on === true && chip !== 'Silent');
                el.classList.toggle('off', on === false);
                el.classList.toggle('idle', chip === 'Silent');
                const state = el.querySelector('.snd-state');
                if (state) state.textContent = chip;
            }
        }

        // What is currently muted, on the Alerts heading itself, so the
        // section says what it is set to before you scroll into it.
        // The icon says how (🔔 both, 🔊 sound only, 💡 lights only, 🔕 nothing
        // can alert), the word says how many categories.
        function setSoundsSummary() {
            const btn = document.getElementById('alerts-summary');
            if (!btn) return;
            if (deviceBeepMask === null || buzzerOn === null) {
                btn.textContent = '—';
                btn.classList.remove('on');
                return;
            }
            const keys = Object.keys(BEEP_BITS);
            const n = keys.filter(k => (deviceBeepMask & BEEP_BITS[k]) !== 0).length;
            const sound = buzzerOn, light = ledMode !== 0;
            const icon = n === 0 || (!sound && !light) ? '🔕'
                       : sound && light ? '🔔' : sound ? '🔊' : '💡';
            const one = { alpr: 'cameras', tracker: 'trackers', drone: 'drones' }[lensOfMask(deviceBeepMask)];
            const what = !sound && !light ? 'off'
                       : n === 0 ? 'none' : n === keys.length ? 'all' : one || n + '/' + keys.length;
            btn.textContent = icon + ' ' + what;
            btn.classList.toggle('on', icon !== '🔕');
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

        // Attack-gear detection. The device is the authority (it persists the
        // flag), so the button paints only from cfg/push, never optimistically.
        let deviceAttack = false;
        let attackPendingUntil = 0;
        const ATTACK_PENDING_MS = 1500;
        function setAttackUi(on) {
            deviceAttack = !!on;
            const b = document.getElementById('btn-attack');
            if (!b) return;
            b.textContent = on ? 'On' : 'Off';
            b.classList.toggle('on', !!on);
            b.classList.toggle('off', !on);
        }
        function toggleAttack() {
            const want = !deviceAttack;
            attackPendingUntil = Date.now() + ATTACK_PENDING_MS;
            setAttackUi(want);
            sendCommand({ attack: want });
        }

        // ===================== Alert log =====================
        // The board records every alert its buzzer sounds to its own flash
        // (firmware/src/alert_log.h). No phone is required, which is the point:
        // a detector wired into a car logs the whole drive while the phone is in
        // a pocket, dead, or at home. The app only turns it on and reads it back.
        //
        // Start/Stop is an app-side BOOKMARK, not a board mode. The board keeps
        // logging either way; a session just remembers "from here" so Stop can
        // read back that stretch. Stopping never disables the board's log.
        let deviceLog = false;
        let logPendingUntil = 0;
        const LOG_PENDING_MS = 1500;
        // Mirrors ALERT_LOG_MAX_RECS in firmware/src/alert_log.h; selftest pins them.
        const LOG_MAX_RECS = 100000;
        const LOG_SESSION_KEY = 'logSession';
        const LOG_EPOCHS_KEY = 'logBootEpochs';
        let logHeld = 0, logBootNow = 0, logSecsNow = 0;
        let logSession = null;   // { boot, secs, at }

        // A record carries (boot, seconds-since-boot), never a wall clock: the
        // board has no RTC and is deliberately offline. Any boot this phone has
        // actually seen can be dated, though, so remember when each one started
        // and old records become real timestamps. First observation wins --
        // later ones drift with the board's own clock.
        let logBootEpochs = {};
        try { logBootEpochs = JSON.parse(localStorage.getItem(LOG_EPOCHS_KEY) || '{}'); } catch (e) { logBootEpochs = {}; }

        function noteBootEpoch(boot, secs) {
            if (!boot || typeof secs !== 'number') return;
            if (logBootEpochs[boot]) return;
            logBootEpochs[boot] = Date.now() - secs * 1000;
            const keys = Object.keys(logBootEpochs).map(Number).sort(function (a, b) { return a - b; });
            while (keys.length > 200) delete logBootEpochs[keys.shift()];
            try { localStorage.setItem(LOG_EPOCHS_KEY, JSON.stringify(logBootEpochs)); } catch (e) {}
        }

        function setLogUi(on) {
            deviceLog = !!on;
            const b = document.getElementById('btn-log');
            if (b) {
                b.textContent = on ? 'On' : 'Off';
                b.classList.toggle('on', !!on);
                b.classList.toggle('off', !on);
            }
            const note = document.getElementById('log-note');
            if (note) {
                if (!on) {
                    note.textContent = 'Off. The board keeps no record of what it beeped at.';
                } else {
                    const pct = Math.min(100, Math.round((logHeld / LOG_MAX_RECS) * 1000) / 10);
                    note.textContent = 'Recording every alert on the board, with or without the phone. '
                        + logHeld.toLocaleString() + ' held (' + pct + '% full)'
                        + (logHeld >= LOG_MAX_RECS ? ' — oldest are being overwritten.' : '.');
                }
            }
            paintLogSession();
        }

        // The Record bar on Sweep. Idle it is one button; running it is a lit
        // bar reading elapsed, what has gone into the log, what has been
        // pinned, and which category is being pinned -- so "am I recording?"
        // and "recording what?" are both answered without a tap.
        function paintLogSession() {
            const bar  = document.getElementById('rec-bar');
            const b    = document.getElementById('btn-record-session');
            const read = document.getElementById('rec-read');
            const stop = document.getElementById('btn-record-stop');
            if (!bar || !b) return;
            const live = !!logSession;
            bar.classList.toggle('live', live);
            b.textContent = live ? '● REC' : '● Record';
            if (stop) stop.hidden = !live;
            if (!read) return;
            if (!live) {
                read.textContent = connectionType
                    ? 'Log what the board beeps at, and pin what it matches.'
                    : 'Connect the board to record an outing.';
                return;
            }
            // m:ss, not fmtUptime's "4m": a recording that reads "0m" for its
            // first whole minute looks like it did not start.
            const secs = Math.max(0, Math.floor((Date.now() - logSession.at) / 1000));
            const el = secs < 3600
                ? Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0')
                : Math.floor(secs / 3600) + ':' + String(Math.floor(secs / 60) % 60).padStart(2, '0')
                  + ':' + String(secs % 60).padStart(2, '0');
            const alerts = alertCount === null ? null : Math.max(0, alertCount - logSession.alerts0);
            const pins = Math.max(0, pinsCache.length - logSession.pins0);
            const bits = [el];
            if (alerts !== null) bits.push(alerts + (alerts === 1 ? ' alert' : ' alerts'));
            if (pins) bits.push(pins + (pins === 1 ? ' pin' : ' pins'));
            const lensName = { all: 'everything', alpr: 'cameras', tracker: 'trackers', drone: 'drones' }[pinLens] || pinLens;
            read.textContent = bits.join(' · ') + ' — pinning ' + lensName;
        }

        function toggleAlertLog() {
            const want = !deviceLog;
            logPendingUntil = Date.now() + LOG_PENDING_MS;
            setLogUi(want);
            sendCommand({ log: want });
        }

        // Nobody who taps Start wants to be told they cannot. Enabling is
        // announced rather than silent, and it stays on afterwards -- the car
        // case depends on the board still logging once you walk away.
        function toggleLogSession() {
            if (!connectionType) { showToast('Connect the device first', '…'); return; }
            if (logSession) { stopLogSession(); return; }
            if (!deviceLog) {
                logPendingUntil = Date.now() + LOG_PENDING_MS;
                setLogUi(true);
                sendCommand({ log: true });
            }
            // One bracketed act. Recording an outing means both halves: the
            // board writes what it beeped at, and the phone offers to pin what
            // it matched. Two separate switches meant "am I recording?" had two
            // answers and you could easily be half on.
            // The bookmark must be the board's clock NOW, not when we connected.
            // log_boot/log_secs arrive only in the CMD:CFG reply, which is asked
            // for once per connection, so logSecsNow is frozen at connect time --
            // starting a recording an hour into a drive bookmarked an hour ago
            // and read back alerts from before the tap. log_secs is seconds since
            // boot, which is exactly what bootAt (from cfg.uptime) tracks, so it
            // can be recomputed here with no extra round trip and no extra bytes
            // on the push, which is the tightest budget on the device.
            const secsNow = bootAt === null ? logSecsNow
                : Math.max(logSecsNow, Math.floor((Date.now() - bootAt) / 1000));
            logSession = {
                boot: logBootNow, secs: secsNow, at: Date.now(),
                alerts0: (alertCount === null ? 0 : alertCount),
                pins0: pinsCache.length,
                // Remember whether the pin prompt was already armed, so Stop
                // puts it back rather than switching off something the user
                // turned on themselves before ever starting a session.
                wasRecording: recordEnabled
            };
            recordEnabled = true;
            try { localStorage.setItem(LOG_SESSION_KEY, JSON.stringify(logSession)); } catch (e) {}
            paintRecord();
            paintLogSession();
            showToast('Recording — the board is logging', '●');
        }

        function stopLogSession() {
            const sess = logSession;
            logSession = null;
            try { localStorage.removeItem(LOG_SESSION_KEY); } catch (e) {}
            // Stop disarms the pin prompt again unless it was on beforehand.
            // Stopping never turns the board's own log off: the car case wants
            // it still logging after you put the phone away.
            recordEnabled = !!(sess && sess.wasRecording);
            try { localStorage.setItem(RECORD_PREF_KEY, recordEnabled ? '1' : '0'); } catch (e) {}
            paintRecord();
            paintLogSession();
            saveAlertLog(false, sess);
        }

        // ---- readback ----------------------------------------------------
        // Bulk, so it follows the capture precedent: a JSON header frame, then
        // base64 payload lines, then a done frame. Paged with an explicit skip
        // because several alerts can share one second, which a timestamp-only
        // cursor would force the app to de-duplicate.
        let logRx = null;
        const LOG_RX_TIMEOUT_MS = 12000;

        function handleLogFrame(o) {
            if (!logRx) return;
            if (o.names) logRx.names = String(o.names).split('\n').filter(Boolean);
            if (o.err) { logRx.fail('device: ' + o.err); return; }
            if ('more' in o) logRx.more = !!o.more;
            if (o.done) logRx.page();
        }

        function readAlertLog(fromBoot, fromSecs, onProgress) {
            return new Promise(function (resolve, reject) {
                if (logRx) { reject(new Error('a readback is already running')); return; }
                const st = {
                    recs: [], names: [], more: false, skip: 0, timer: null,
                    fail: function (msg) { clearTimeout(st.timer); logRx = null; reject(new Error(msg)); },
                    arm: function () {
                        clearTimeout(st.timer);
                        st.timer = setTimeout(function () { st.fail('the board stopped replying'); }, LOG_RX_TIMEOUT_MS);
                    },
                    page: function () {
                        // One page done. Keep going only while the board says
                        // more remain, advancing skip by what actually arrived.
                        if (onProgress) onProgress(st.recs.length);
                        if (!st.more) {
                            clearTimeout(st.timer); logRx = null;
                            resolve({ recs: st.recs, names: st.names });
                            return;
                        }
                        st.skip = st.recs.length;
                        st.more = false;
                        st.arm();
                        sendCommand({ raw: 'CMD:LOG:READ:' + fromBoot + ':' + fromSecs + ':' + st.skip });
                    }
                };
                logRx = st;
                st.arm();
                sendCommand({ raw: 'CMD:LOG:READ:' + fromBoot + ':' + fromSecs + ':0' });
            });
        }

        // 16-byte fixed records; the layout is the wire contract with
        // firmware/src/alert_log.h and app/selftest.js pins the two together.
        function parseLogRecords(chunks, names) {
            const out = [];
            for (const bytes of chunks) {
                for (let i = 0; i + 16 <= bytes.length; i += 16) {
                    const boot = bytes[i] | (bytes[i + 1] << 8);
                    const secs = (bytes[i + 2] | (bytes[i + 3] << 8) |
                                  (bytes[i + 4] << 16) | (bytes[i + 5] << 24)) >>> 0;
                    let mac = '';
                    for (let k = 0; k < 6; k++) {
                        mac += (k ? ':' : '') + bytes[i + 6 + k].toString(16).padStart(2, '0');
                    }
                    const ruleIdx = bytes[i + 13];
                    out.push({
                        boot: boot, secs: secs,
                        mac: mac.toUpperCase(),
                        cat: bytes[i + 12],
                        rule: (names && ruleIdx < names.length) ? names[ruleIdx] : '',
                        rssi: (bytes[i + 14] << 24) >> 24
                    });
                }
            }
            return out;
        }

        // Category byte -> label. Mirrors AlertCategory in
        // firmware/src/hardware_manager.h; selftest pins the order.
        const LOG_CATS = ['ALPR / Camera', 'Body Cam', 'Drone', 'Tracker', 'Other'];

        function logWallClock(rec) {
            const epoch = logBootEpochs[rec.boot];
            return epoch ? new Date(epoch + rec.secs * 1000) : null;
        }

        function logLine(rec) {
            const when = logWallClock(rec);
            const pad = function (n) { return String(n).padStart(2, '0'); };
            const t = when
                ? when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate()) +
                  ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes()) + ':' + pad(when.getSeconds())
                // A boot this phone never saw cannot be dated: the board has no
                // clock. Say how far into that boot it was rather than invent one.
                : ('boot ' + rec.boot + ' +' + rec.secs + 's').padEnd(19);
            const cat = LOG_CATS[rec.cat] || ('cat ' + rec.cat);
            let vend = '';
            try { vend = vendorOf({ mac: rec.mac, pub: true }) || ''; } catch (e) { vend = ''; }
            return [t, cat.padEnd(13), rec.mac, vend.padEnd(18),
                    rec.rule ? '"' + rec.rule + '"' : '', String(rec.rssi)]
                   .join('  ').replace(/\s+$/, '');
        }

        function logSummary(recs) {
            const by = {};
            const macs = {};
            for (const r of recs) {
                const k = LOG_CATS[r.cat] || 'Other';
                by[k] = (by[k] || 0) + 1;
                macs[r.mac] = 1;
            }
            return { total: recs.length, devices: Object.keys(macs).length, by: by };
        }

        // Writes the human file. Plaintext in Documents beside the .sscap
        // captures, deliberately: it carries no location, and a PIN prompt on
        // the move is how a log never gets saved.
        async function saveAlertLog(everything, sess) {
            if (!connectionType) { showToast('Connect the device first', '…'); return; }
            const from = (!everything && sess) ? sess : { boot: 0, secs: 0 };
            showToast('Reading the log from the board…', '…');
            let got;
            try {
                got = await readAlertLog(from.boot | 0, from.secs | 0, function (n) {
                    if (n && n % 512 === 0) showToast('Read ' + n + '…', '…');
                });
            } catch (e) {
                showToast('Could not read the log: ' + e.message, '⚠');
                return;
            }
            const recs = parseLogRecords(got.recs, got.names);
            if (!recs.length) { showToast('Nothing logged in that range', '○'); return; }

            const sum = logSummary(recs);
            const name = 'signalsweep-log-' + capStamp() + '.txt';
            const head = [
                '# SignalSweep alert log',
                '# board: ' + (devName || 'unknown') + '   pulled: ' + new Date().toLocaleString(),
                '# ' + sum.total + ' alerts from ' + sum.devices + ' devices',
                '# times are local. "boot N +Ms" = a boot this phone never saw, so it cannot be dated.',
                '# no location is recorded, by design.',
                ''
            ].join('\n');
            const body = recs.map(logLine).join('\n') + '\n';

            let saved = null;
            if (capNativeFs()) {
                try {
                    await window.CapFilesystem.writeFile({
                        path: name, data: head + body,
                        directory: window.CapDirectory.Documents,
                        encoding: window.CapEncoding.UTF8, recursive: true
                    });
                    saved = name;
                } catch (e) {
                    showToast('Could not write the file: ' + e.message, '⚠');
                }
            }
            showLogSummary(sum, saved, recs);
        }

        function showLogSummary(sum, savedAs, recs) {
            const body = document.getElementById('logsum-body');
            if (body) {
                let html = '<div class="logsum-big">' + sum.total + '</div>'
                         + '<div class="logsum-sub">alerts from ' + sum.devices + ' device'
                         + (sum.devices === 1 ? '' : 's') + '</div><div class="logsum-rows">';
                for (const k of LOG_CATS) {
                    if (!sum.by[k]) continue;
                    const c = categoryOf(k);
                    html += '<div class="logsum-row"><span style="color:' + esc(c.color) + '">'
                          + esc(c.icon || '•') + ' ' + esc(k) + '</span><strong>'
                          + sum.by[k] + '</strong></div>';
                }
                html += '</div>';
                html += savedAs
                    ? '<p class="set-note">Saved to Documents as <code>' + esc(savedAs) + '</code></p>'
                    : '<p class="set-note">Not saved to a file — no filesystem on this platform.</p>';
                const fw = logWallClock(recs[0]), lw = logWallClock(recs[recs.length - 1]);
                if (fw && lw) {
                    html += '<p class="set-note">' + esc(fw.toLocaleString()) + ' → '
                          + esc(lw.toLocaleString()) + '</p>';
                }
                body.innerHTML = html;
            }
            const m = document.getElementById('logsum-modal');
            if (m) m.classList.add('active');
        }

        function clearAlertLogConfirm() {
            if (!connectionType) { showToast('Connect the device first', '…'); return; }
            if (!confirm('Erase the alert log on the board? ' + logHeld.toLocaleString()
                         + ' records will be gone for good.')) return;
            sendCommand({ raw: 'CMD:LOG:CLEAR' });
            logHeld = 0;
            setLogUi(deviceLog);
            showToast('Log cleared', '○');
        }

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
            // The sound settings ride the 1 Hz push as well as the CMD:CFG
            // reply, so the controls reconcile with the board every second
            // rather than once per connection. This is what makes a lost write
            // self-heal instead of stranding the app until a factory reset.
            if (typeof data.beep_mask === 'number') setBeepUi(data.beep_mask);
            if (typeof data.buzzer === 'boolean') setBuzzerUi(data.buzzer);
            if (typeof data.led === 'number') setLedUi(data.led);
            if (typeof data.theme === 'number') setThemeUi(data.theme);
            if (typeof data.band === 'number') setBandUi(data.band);
            const devAll = !!data.scan_all;
            if (devAll !== foxhuntMode && Date.now() > filterPendingUntil) {
                foxhuntMode = devAll;
                paintFilter();
            }
            // attack rides the push conditionally (absent = off), and the app
            // adopts it, so a board that ran headless comes back showing its
            // real state. attackPendingUntil ignores a stale echo right after a tap.
            const devAtk = !!data.attack;
            if (devAtk !== deviceAttack && Date.now() > attackPendingUntil) setAttackUi(devAtk);
            // Alert logging rides the push conditionally too (absent = off).
            const devLog = !!data.log;
            if (devLog !== deviceLog && Date.now() > logPendingUntil) setLogUi(devLog);
            if (typeof data.alerts === 'number') alertCount = data.alerts;
            // Every push, so uptime ticks with no timer of its own.
            renderStatusStrip();
        }

        // BLE notifications are unacknowledged, and the app asks for the config
        // exactly once. If that one reply is dropped every settings control
        // paints a stale or default value for the whole session, silently. So
        // ask again until one lands, then stop.
        let cfgSeen = false;
        const CFG_RETRY_MS = [400, 1500, 4000];

        function requestConfig() {
            cfgSeen = false;
            CFG_RETRY_MS.forEach(ms => setTimeout(() => {
                if (!cfgSeen && connectionType) sendCommand({ raw: 'CMD:CFG' });
            }, ms));
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

        // Device is the authority: a tap asks and the firmware's cfg reply
        // repaints. No optimistic paint -- if the command never lands the
        // button must not claim it did.
        function setSound(on) {
            if (buzzerOn === null) { showToast('Waiting for the device', '…'); return; }
            if (on === buzzerOn) return;
            const el = document.querySelector('#sound-modes .radio-tab[data-sound="' + (on ? 1 : 0) + '"]');
            if (el) el.classList.add('pending');
            sendCommand({ buzzer: on });
        }

        function setBuzzerUi(on) {
            buzzerOn = (typeof on === 'boolean') ? on : null;
            document.querySelectorAll('#sound-modes .radio-tab').forEach(function (el) {
                const pressed = buzzerOn !== null && (el.getAttribute('data-sound') === '1') === buzzerOn;
                el.setAttribute('aria-pressed', pressed ? 'true' : 'false');
                el.classList.remove('pending');
            });
            paintAlertRows();
            setSoundsSummary();
        }

        // LED mode: 0 off, 1 one LED, 2 dim, 3 full (firmware LedMode). Same
        // contract as the buzzer -- painted only from device frames, a tap
        // just asks and marks the button pending until the reply lands.
        let ledMode = null;
        function setLedUi(n) {
            ledMode = (typeof n === 'number') ? n : null;
            document.querySelectorAll('#led-modes .radio-tab').forEach(function (el) {
                const on = ledMode !== null && Number(el.getAttribute('data-led')) === ledMode;
                el.setAttribute('aria-pressed', on ? 'true' : 'false');
                el.classList.remove('pending');
            });
            paintAlertRows();
            setSoundsSummary();
            paintThemeNote();
        }
        function setLed(n) {
            if (ledMode === null) { showToast('Waiting for the device', '…'); return; }
            if (n === ledMode) return;
            const el = document.querySelector('#led-modes .radio-tab[data-led="' + n + '"]');
            if (el) el.classList.add('pending');
            sendCommand({ led: n });
        }

        // Theme: firmware ThemeId, same index order (selftest pins it). One
        // pick sets the bar's colour and the buzzer's pitch. Same contract as
        // the LED mode -- painted only from device frames, a tap just asks.
        const THEMES = ['classic', 'night', 'terminal', 'glacier', 'party'];
        let themeId = null;
        // The two things a theme costs you, said plainly under the picker.
        function themeNote(theme, led) {
            // One LED is Classic-only regardless of theme -- check it first,
            // or Party's note would show even though One overrides it.
            if (typeof theme === 'number' && theme !== 0 && led === 1)
                return 'One LED keeps Classic colours, so you can still tell alerts apart.';
            if (theme === 4 && led !== 0) return 'Party lights the whole bar all the time. Anyone nearby can see it.';
            return '';
        }
        function paintThemeNote() {
            const el = document.getElementById('theme-note');
            if (!el) return;
            const t = themeNote(themeId, ledMode);
            el.textContent = t;
            el.hidden = !t;
        }
        function setThemeUi(n) {
            themeId = (typeof n === 'number') ? n : null;
            document.querySelectorAll('#theme-modes .theme-chip').forEach(function (el) {
                const on = themeId !== null && Number(el.getAttribute('data-theme')) === themeId;
                el.setAttribute('aria-pressed', on ? 'true' : 'false');
                el.classList.remove('pending');
            });
            paintThemeNote();
        }
        function setTheme(n) {
            if (themeId === null) { showToast('Waiting for the device', '…'); return; }
            if (n === themeId) return;
            const el = document.querySelector('#theme-modes .theme-chip[data-theme="' + n + '"]');
            if (el) el.classList.add('pending');
            sendCommand({ theme: n });
        }

        // Wi-Fi bands (XIAO C5 only): 0 both, 1 2.4 GHz, 2 5 GHz -- firmware SweepBand
        // order (selftest pins it). The row stays hidden for a board that never
        // reports a band (the S3 has one), and like the LED mode it paints only from
        // device frames; a tap just asks and marks the button pending.
        let bandId = null;
        function setBandUi(n) {
            bandId = (typeof n === 'number') ? n : null;
            const row = document.getElementById('band-row');
            if (row) row.hidden = bandId === null;
            document.querySelectorAll('#band-modes .radio-tab').forEach(function (el) {
                const on = bandId !== null && Number(el.getAttribute('data-band')) === bandId;
                el.setAttribute('aria-pressed', on ? 'true' : 'false');
                el.classList.remove('pending');
            });
        }
        function setBand(n) {
            if (bandId === null) { showToast('Waiting for the device', '…'); return; }
            if (n === bandId) return;
            const el = document.querySelector('#band-modes .radio-tab[data-band="' + n + '"]');
            if (el) el.classList.add('pending');
            sendCommand({ band: n });
        }

        // The rules the device is actually carrying. Until they arrive the box
        // is not editable and Save is disabled: the editor used to open blank
        // against an unknown board, so saving replaced a rule set nobody had
        // ever seen. Requested on open, never on connect -- the reply is
        // multi-KB and the 1 Hz push is the tightest budget on the device.
        let sigsLoaded = false;

        function setSigUi(rules) {
            const box  = document.getElementById('sig-input');
            const save = document.getElementById('btn-sig-save');
            sigsLoaded = Array.isArray(rules);
            if (box) {
                box.value = sigsLoaded ? JSON.stringify(rules, null, 2) : '';
                box.placeholder = sigsLoaded ? ''
                    : connectionType ? 'Reading rules from the device…'
                                     : 'Connect to a device to see the rules it is carrying.';
                box.readOnly = !sigsLoaded;
            }
            if (save) save.disabled = !sigsLoaded;
        }

        function requestSignatures() {
            setSigUi(null);
            sendCommand({ raw: 'CMD:SIGS' });
        }

        function openSignatures() {
            document.getElementById('sig-modal').classList.add('active');
            requestSignatures();
        }
        function saveSignatures() {
            if (!sigsLoaded) { showToast('Device rules not loaded yet', '…'); return; }
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
            // Repaint from the device rather than assuming what the defaults are.
            setTimeout(requestSignatures, 300);
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
            if (isConnected) {
                connectionType = type;
                closeConnModal();
                renderStatusStrip();
                showToast(`Connected via ${type}`, '✓');
                // Ask the device what it is, and what it was already doing.
                // Done here rather than at each of the five connect sites.
                // requestConfig() owns its own delay and retries -- the first
                // attempt waits for the NUS notify subscription to come up.
                requestConfig();
                setHostKeepalive(type === 'USB' || type === 'SERIAL');
            } else {
                setHostKeepalive(false);
                connectionType = null;
                // Stop showing the last board's settings as if they were this
                // one's -- with two boards around that is how you mute the
                // wrong device.
                setBuzzerUi(null);
                setLedUi(null);
                setThemeUi(null);
                setBandUi(null);
                // Same reason: the category mask is per-board too, and it used
                // to survive a disconnect as five checkboxes still showing the
                // last device's settings.
                setBeepUi(null);
                setSigUi(null);
                devName = ''; bootAt = null; alertCount = null;
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

        // Plugin and browser errors are written for developers ("Connection
        // failed with GATT_ERROR.", "IO_ERROR"). Each known one becomes what to
        // do next; anything unknown keeps its raw text so it can still be
        // reported. `what` names the step for that fallback.
        const FRIENDLY_ERRORS = [
            [/timeout|Connection failed|GATT|Service discovery/i,
                "The board didn't answer. Move closer and try again; if it keeps failing, unplug the board for a few seconds."],
            [/Not connected|disconnected|DEVICE_DISCONNECTED|NO_DEVICE/i,
                "Can't reach the board. Check it has power and is close by, then tap Connect."],
            [/not initialized/i, "Bluetooth wasn't ready yet. Tap Connect again."],
            [/BLE is not (available|supported)|Bluetooth is not supported/i,
                "This phone doesn't support Bluetooth LE. Use the USB cable instead."],
            [/PERMISSION_DENIED|NEEDS_PERMISSION/,
                'USB access was refused. Unplug the cable, plug it back in and tap OK when Android asks.'],
            [/IO_ERROR|PORT_NOT_OPEN|INVALID_STATE/,
                'The cable link failed. Unplug the board, plug it back in and tap Connect.'],
            [/already open|Failed to open/i,
                'The port is busy. Close anything else using it (a serial monitor, another tab), then try again.'],
        ];
        function friendlyError(what, err) {
            const raw = String((err && (err.code || err.message)) || err);
            const full = raw + ' ' + String((err && err.message) || '');
            const hit = FRIENDLY_ERRORS.find(([re]) => re.test(full));
            return hit ? hit[1] : `${what} failed: ${raw}`;
        }

        async function connectNativeBluetooth() {
            setConnState('warn', 'Connecting…');
            try {
                await window.BleClient.initialize({ androidNeverForLocation: true });
                // With the radio off the picker just scans nothing and shows an
                // empty list, with no hint why. Ask Android to turn it on (its
                // own one-tap dialog); if that is refused or unavailable, open
                // the Bluetooth settings page and stop here.
                if (!(await window.BleClient.isEnabled())) {
                    try { await window.BleClient.requestEnable(); } catch (e) { /* declined */ }
                    if (!(await window.BleClient.isEnabled())) {
                        showToast('Bluetooth is off. Turn it on, then tap Connect.', '⚠');
                        try { await window.BleClient.openBluetoothSettings(); } catch (e) {}
                        updateConnectionUI(false);
                        return;
                    }
                }
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
                const msg = String((err && err.message) || err);
                // Closing the picker is a choice, not a failure: undo the
                // "connecting" dot without the "Device disconnected" toast.
                if (/cancelled/i.test(msg)) {
                    renderStatusStrip();
                    return;
                }
                updateConnectionUI(false);
                // After one refusal Android stops asking for Nearby devices, so
                // every Connect failed with a raw "Permission denied." The only
                // way back is the app's own settings page.
                if (/permission/i.test(msg)) {
                    showToast('SignalSweep needs the Nearby devices permission. Allow it, then tap Connect.', '⚠');
                    try { await window.BleClient.openAppSettings(); } catch (e) {}
                    return;
                }
                showToast(friendlyError('Bluetooth connect', err), '✕');
            }
        }

        // Re-adopt a link the OS still holds. Android can destroy and recreate
        // the Activity (low memory, a theme switch) while the process and its
        // GATT link live on: the page came back "disconnected", the board had
        // stopped advertising because it was still connected, so the picker
        // found nothing -- stuck until the link dropped or a force stop.
        let reconciling = false;
        async function reconcileConnection() {
            if (!(window.Capacitor && window.Capacitor.isNativePlatform() && window.BleClient)) return;
            if (reconciling || connectionType === 'USB' || connectionType === 'SERIAL') return;
            // initialize() raises the Nearby-devices prompt on a phone that has
            // never connected over BLE -- never on launch. A phone that has
            // connected before has granted it already.
            let last = null;
            try { last = localStorage.getItem(LAST_DEVICE_KEY); } catch (e) {}
            if (!last && connectionType !== 'BLE') return;
            reconciling = true;
            try {
                // Without this, the connected-devices query throws "Bluetooth LE not
                // initialized" on every fresh page, which is how the bug hid.
                await window.BleClient.initialize({ androidNeverForLocation: true });
                const connected = await window.BleClient.getConnectedDevices([NUS_SERVICE_UUID]);
                const device = connected && connected[0];
                if (device) {
                    if (connectionType !== 'BLE' || !bleDevice) {
                        // A recreated page gets a fresh plugin with no GATT client
                        // of its own; connect() first (already-connected is success).
                        try { await window.BleClient.connect(device.deviceId, () => onDeviceDisconnected()); } catch (e) {}
                        bleDevice = device;
                        await subscribeNative(device.deviceId);
                        wantConnection = true;
                        reconnectDelay = 0;
                        updateConnectionUI(true, 'BLE');
                    }
                } else if (connectionType === 'BLE') {
                    onDeviceDisconnected();
                }
            } catch (e) {
                console.warn('reconcileConnection error:', e);
            } finally {
                reconciling = false;
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
            setConnState('warn', 'Connecting…');
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
                    showToast(friendlyError('Bluetooth connect', err), '✕');
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

        // A capture floods the USB link with data events. Decoding and parsing
        // each one synchronously in the listener saturated the main thread and
        // OOM-crashed the WebView renderer mid-capture (the "capture didn't save"
        // bug). Instead the listener does O(1) work -- just queue the raw base64
        // -- and one requestAnimationFrame drain per frame decodes the whole
        // batch at once. Paced to the display, so the thread breathes, the screen
        // keeps painting, and allocations batch instead of thrashing the GC.
        let usbRawQueue = [];
        let usbDrainScheduled = false;
        function scheduleUsbDrain() {
            if (usbDrainScheduled) return;
            usbDrainScheduled = true;
            // rAF never fires on a hidden page: with the screen off on a cable
            // the queue grew unread (340 chunks in a short doze on the bench)
            // and then decoded all at once on wake. Hidden pages get a timer,
            // which the WebView throttles, so batches stay bounded.
            if (document.hidden) setTimeout(drainUsbQueue, 50);
            else requestAnimationFrame(drainUsbQueue);
        }
        function drainUsbQueue() {
            usbDrainScheduled = false;
            if (!usbRawQueue.length) return;
            const batch = usbRawQueue;
            usbRawQueue = [];
            let text = '';
            for (let i = 0; i < batch.length; i++) {
                try { text += usbDecoder.decode(b64ToBytes(batch[i]), { stream: true }); } catch (e) {}
            }
            if (text) processIncomingChunk(text);
            if (usbRawQueue.length) scheduleUsbDrain();   // more arrived while draining
        }

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
            setConnState('warn', 'Connecting…');
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
                    // The plugin's `granted` is always false on Android 12+: its
                    // PendingIntent is FLAG_IMMUTABLE, which strips the
                    // EXTRA_PERMISSION_GRANTED extra it reads. Tapping OK then
                    // read as "denied" and the connect silently stopped (bench,
                    // OnePlus API 36: granted:false, hasPermission true right
                    // after). Ask the USB manager instead.
                    await window.UsbSerial.requestPermission({ deviceId: dev.deviceId });
                    const { granted } = await window.UsbSerial.hasPermission({ deviceId: dev.deviceId });
                    if (!granted) {
                        updateConnectionUI(false);
                        showToast('USB access was refused. Unplug the cable, plug it back in and tap OK when Android asks.', '✕');
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
                    // O(1): queue the raw base64 and let the rAF drain decode the
                    // batch. The decoded text still feeds the same line reassembler
                    // BLE and WebSerial use -- one parser, three transports.
                    usbRawQueue.push(ev.data);
                    scheduleUsbDrain();
                }));
                usbListeners.push(await window.UsbSerial.addListener('detached', () => {
                    showToast('USB device unplugged', '✕');
                    onDeviceDisconnected();
                }));
                // The plugin discards its reader on a stream error, so no more
                // data will ever arrive. Only warning here left the app showing
                // "connected" to a dead link -- and a capture waiting forever.
                usbListeners.push(await window.UsbSerial.addListener('error', (ev) => {
                    console.warn('USB stream error:', ev && ev.message);
                    showToast('USB link lost — reconnect', '✕');
                    onDeviceDisconnected();
                }));

                await window.UsbSerial.startReading({ portId });
                updateConnectionUI(true, 'USB');
                offerReceiveOnlyOnCable();
            } catch (err) {
                console.error('USB connect failed:', err);
                usbPortId = null;
                updateConnectionUI(false);
                showToast(friendlyError('USB connect', err), '✕');
            }
        }

        async function teardownUsb() {
            // Chunks still queued belong to the port being closed. Draining them
            // after the disconnect painted a stale push over the cleared strip
            // (Alerts since boot kept its number on a disconnected screen).
            usbRawQueue = [];
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
            setConnState('warn', 'Connecting…');
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
                    showToast(friendlyError('Serial connect', err), '✕');
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

        // GATT permits exactly one write in flight per connection. A second
        // issued while the first is outstanding is rejected outright
        // (InvalidStateError / "GATT operation already in progress"), and since
        // nothing awaits sendCommand the command is simply lost -- with a
        // "BLE Transmit Error" toast as the only trace. That was reachable from
        // ordinary use: the five sound toggles each fired their own command, so
        // muting three categories quickly raced three writes against each other.
        // One chain serializes every device command on every transport. Callers
        // stay fire-and-forget; this is a queue, not an awaited API.
        let txChain = Promise.resolve();
        // Cable host session. The firmware can't tell an open port from a cable
        // that is merely plugged in, so the app announces itself: CMD:HOST every
        // 2 s while it holds a USB/serial port (first one chirps "connected"),
        // CMD:HOST:BYE on a deliberate disconnect. If they just stop -- cable
        // yanked, app killed -- the board chirps "gone" after 6 s. See loop() in
        // firmware/src/main.cpp. BLE needs none of this: GATT has real events.
        const HOST_KEEPALIVE_MS = 2000;
        let hostTimer = null;
        function setHostKeepalive(on) {
            if (hostTimer) { clearInterval(hostTimer); hostTimer = null; }
            cableWake = on;
            if (on) capAcquireWake(); else capReleaseWake();
            if (!on) return;
            sendCommand({ raw: 'CMD:HOST' });
            hostTimer = setInterval(function () { sendCommand({ raw: 'CMD:HOST' }); }, HOST_KEEPALIVE_MS);
        }

        function sendCommand(cmdObj) {
            // Same handler on both arms: a failed write must not break the chain
            // and strand every command after it.
            const run = () => sendCommandNow(cmdObj);
            txChain = txChain.then(run, run);
            return txChain;
        }

        async function sendCommandNow(cmdObj) {
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
                    showToast(friendlyError('Sending to the board', err), '✕');
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
                    showToast(friendlyError('Sending to the board', err), '\u2715');
                    return false;
                }
            } else if (connectionType === 'SERIAL' && serialWriter) {
                try { await serialWriter.write(jsonStr); return true; }
                catch (err) {
                    console.error('Serial write error:', err);
                    showToast(friendlyError('Sending to the board', err), '✕');
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
            // Say goodbye while the port is still open, so the board chirps now
            // rather than after its 6 s timeout.
            if (connectionType === 'USB' || connectionType === 'SERIAL') {
                setHostKeepalive(false);
                try { await sendCommand({ raw: 'CMD:HOST:BYE' }); } catch (e) {}
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
            setConnState('warn', 'Reconnecting in ' + secs + 's…');
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
            // capturing used to survive the link, leaving the page stuck on a
            // countdown no frame would ever move.
            if (capturing) capAbort('Board disconnected — capture stopped, partial file kept', false);
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
            // A readback in flight will never complete once the link is gone --
            // fail it now rather than leave the promise hanging and lock out the
            // next attempt on "a readback is already running".
            if (logRx) logRx.fail('disconnected');
            liveMatches = {};
            mapFix = null;
            huntMac = '';
            huntTrace = [];
            expandedGroups = new Set();
            // Per link, not per app session: a bad stretch on the last board
            // must not paint "updates lost" over the next one.
            rxOk = 0; rxDropped = 0;
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
            paintRecord();
            // An open log session is a bookmark, not a trail: two integers saying
            // where to start reading. Android kills the app behind the camera and
            // in the background, and losing the mark would silently turn Stop into
            // "give me everything".
            try {
                const raw = localStorage.getItem(LOG_SESSION_KEY);
                if (raw) logSession = JSON.parse(raw);
            } catch (e) { logSession = null; }
            paintLogSession();

            checkApiSupport();
            renderScope();
            setTimeout(async () => {
                await reconcileConnection();
                if (!connectionType) openConnModal();
            }, 600);

            setTimeout(() => {
                if (window.App) {
                    // Back backgrounds, it does not finish the Activity. exitApp()
                    // killed the page but not the process, so the BLE link and
                    // the USB port outlived the UI that owned them. Disconnect
                    // is the way to let go of the board.
                    window.App.addListener('backButton', () => window.App.minimizeApp());
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
                results.catSoundThinking = categoryOf('SoundThinking').key === 'alpr';

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
                      lat: 30.2, lng: -92.0, op_lat: 30.1, op_lng: -92.1, alt: 120, speed: 4.5 },
                    { mac: 'AA:00:05', type: 'Fleet / Infrastructure', rssi: -90, confidence: 80 }
                ]);
                results.lensAll     = liveRows('all').length === 5;
                results.lensDrone   = liveRows('drone').length === 1;
                results.lensTracker = liveRows('tracker').length === 1;
                // Surveillance is the umbrella over ALPR + body cam.
                // Strictly: a fleet router (category 'other') stays out, and the
                // tab's beep preset carries no GENERIC bit.
                results.lensAlpr    = liveRows('alpr').length === 2 &&
                    (LENS_MASK.alpr & BEEP_BITS.generic) === 0;
                // Strongest-first ordering is what the list relies on.
                results.lensSorted  = liveRows('all')[0].mac === 'AA:00:01';
                const drone = liveMatches['AA:00:04'];
                results.droneFields = drone.uasId === 'X7' && drone.lat === 30.2 &&
                                      drone.opLat === 30.1 && drone.alt === 120;
                // Detail line renders the decoded values, escaped.
                results.droneDetail = detailLine(drone, categoryOf('Drone')).indexOf('X7') > 0;
                // A device-chosen name must never reach the DOM as markup.
                results.escapesName = esc('<img src=x onerror=1>').indexOf('<') === -1;
                // Known plugin errors say what to do; unknown ones keep their text.
                results.friendlyErrors =
                    /didn't answer/.test(friendlyError('x', new Error('Connection failed with GATT_ERROR.'))) &&
                    /reach the board/.test(friendlyError('x', new Error('Not connected to device.'))) &&
                    /cable link/.test(friendlyError('x', { code: 'IO_ERROR', message: 'Broken pipe' })) &&
                    friendlyError('USB connect', new Error('weird')) === 'USB connect failed: weird';
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
                // Filter on hides the unmatched row at once, not 8 s later
                // when it goes stale.
                results.filterOnHidesUnmatched = liveRows('all').length === 1 &&
                                                 liveRows('all')[0].mac === 'BB:00:02';

                // Pin filter: looking at cameras must not ask about trackers,
                // and a skipped tracker is still offered once the filter widens.
                pinLens = 'alpr';
                consentQueue = [];
                handledMacs.clear();
                ingestTargets([
                    { mac: 'DD:00:01', type: 'Flock Safety', rssi: -50, confidence: 80 },
                    { mac: 'DD:00:02', type: 'Tracker',      rssi: -60, confidence: 80 }
                ]);
                results.pinFilterSkips = consentQueue.length === 1 && consentQueue[0].mac === 'DD:00:01';
                pinLens = 'all';
                ingestTargets([{ mac: 'DD:00:02', type: 'Tracker', rssi: -60, confidence: 80 }]);
                results.pinFilterWidens = consentQueue.length === 2 && consentQueue[1].mac === 'DD:00:02';

                // Band tabs <-> device mask. Every preset maps back to its tab,
                // Everything is every bit, and a custom mix is no tab at all.
                results.lensMaskRoundTrip =
                    Object.keys(LENS_MASK).every(k => lensOfMask(LENS_MASK[k]) === k) &&
                    LENS_MASK.all === Object.values(BEEP_BITS).reduce((a, b) => a | b, 0) &&
                    lensOfMask(LENS_MASK.tracker | LENS_MASK.drone) === null;
                // A board set headless opens on its tab; a custom mix leaves
                // the tab alone; tapping the selected tab goes back to all.
                setBeepUi(LENS_MASK.tracker);
                const adopted = lens === 'tracker' && pinLens === 'tracker';
                setBeepUi(LENS_MASK.tracker | LENS_MASK.drone);
                const kept = lens === 'tracker';
                setBeepUi(null);
                setLens('drone'); setLens('drone');
                results.lensAdoptsDevice = adopted && kept && lens === 'all';
                pinLens = 'all';

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

                // AP / client split inside the Wi-Fi tab, and nowhere else.
                liveMatches['CC:00:02'].ap = 1;
                liveMatches['CC:00:03'].ap = 0;
                setRadio('WiFi');
                setWifiRole('ap');
                const apRows = liveRows('all');
                setWifiRole('client');
                const clientRows = liveRows('all');
                setRadio('any');   // role still 'client': must not hide anything here
                results.wifiRoleFilter = apRows.length === 1 && apRows[0].mac === 'CC:00:02' &&
                                         clientRows.length === 1 && clientRows[0].mac === 'CC:00:03' &&
                                         liveRows('all').length === 4;
                setWifiRole('any');

                // The badge is how you tell the two apart in a wall of rows.
                results.radioBadges =
                    radioBadges('WiFi').indexOf('wifi') > 0 &&
                    radioBadges('WiFi').indexOf('ble') === -1 &&
                    radioBadges('BLE').indexOf('ble') > 0 &&
                    radioBadges('BLE+WiFi').indexOf('ble') > 0 &&
                    radioBadges('BLE+WiFi').indexOf('wifi') > 0 &&
                    radioBadges('') === '';
                // AP vs client, and plain Wi-Fi when the firmware doesn't say.
                results.wifiRoleBadges =
                    radioBadges('WiFi', 1).indexOf('AP') > 0 &&
                    radioBadges('WiFi', 0).indexOf('Client') > 0 &&
                    radioBadges('WiFi').indexOf('AP') === -1 &&
                    radioBadges('WiFi').indexOf('Client') === -1;

                // Band chip from the firmware's per-target channel, and a push
                // that omits it (older firmware, a BLE sighting) must not blank
                // a badge the last WiFi push already set.
                results.bandOfChannel = bandOfChannel(1) === '2.4' && bandOfChannel(14) === '2.4' &&
                    bandOfChannel(36) === '5' && bandOfChannel(165) === '5' &&
                    bandOfChannel(0) === null && bandOfChannel(undefined) === null && bandOfChannel(20) === null;
                ingestTargets([{ mac: 'CC:00:00:00:00:01', rssi: -50, protocol: 'WiFi', ch: 36 }]);
                ingestTargets([{ mac: 'CC:00:00:00:00:01', rssi: -51, protocol: 'WiFi' }]);   // push without ch
                results.chKeptWhenMissing = liveMatches['CC:00:00:00:00:01'].ch === 36 &&
                    bandChip(36) === '<span class="radio-badge chan">5G · ch 36</span>' && bandChip(0) === '';
                delete liveMatches['CC:00:00:00:00:01'];

                // Same-box grouping: near-MAC Wi-Fi siblings join, a gap over
                // SIBLING_SPAN splits, SSID never joins, BLE never joins.
                const w = function (mac, rssi, extra) { return Object.assign({ mac: mac, rssi: rssi, protocol: 'WiFi' }, extra || {}); };
                const g1 = groupSiblings([w('AA:BB:CC:DD:EE:10', -40), w('aa:bb:cc:dd:ee:14', -60), w('AA:BB:CC:DD:EE:19', -70)]);
                results.siblingSpan = g1.length === 2 && g1[0].members.length === 2 && g1[1].members.length === 1;   // +4 joins, +5 does not
                // Both groups above share the first-5-octet prefix
                // 'AA:BB:CC:DD:EE' -- a key of just the prefix would collide
                // and merge their expansion state. Keying on the group's own
                // lowest last octet keeps them apart.
                results.siblingKeysUnique = g1[0].key !== g1[1].key &&
                    g1[0].key === 'AA:BB:CC:DD:EE:10' && g1[1].key === 'AA:BB:CC:DD:EE:19';
                const g2 = groupSiblings([w('AA:BB:CC:DD:EE:08', -50), w('AA:BB:CC:DD:EE:00', -40), w('AA:BB:CC:DD:EE:04', -45)]);
                results.siblingChain = g2.length === 1 && g2[0].members.length === 3 && g2[0].members[0].mac === 'AA:BB:CC:DD:EE:08';
                const g3 = groupSiblings([w('11:11:11:11:11:01', -40, { ssid: 'Home' }), w('22:22:22:22:22:01', -41, { ssid: 'Home' }),
                                          { mac: 'AA:BB:CC:DD:EE:11', rssi: -42, protocol: 'BLE' }, w('AA:BB:CC:DD:EE:12', -43)]);
                results.siblingNeverSsidOrBle = g3.length === 4;
                // Virtual networks on one router: last 5 octets equal, first
                // octet differs with the locally-administered bit set, same
                // channel when both are known (field drives, 2026-09-16).
                const g4 = groupSiblings([w('60:22:32:EE:AC:17', -60, { ch: 161 }), w('66:22:32:EE:AC:17', -61, { ch: 161 }),
                                          w('6A:22:32:EE:AC:17', -62, { ch: 161 }), w('6E:22:32:EE:AC:17', -63)]);
                results.virtualBssidJoins = g4.length === 1 && g4[0].members.length === 4 && g4[0].key === '60:22:32:EE:AC:17';
                results.virtualBssidChannelMismatch = groupSiblings([w('60:22:32:EE:AC:17', -60, { ch: 161 }), w('66:22:32:EE:AC:17', -61, { ch: 157 })]).length === 2;
                results.virtualBssidNeedsLocalBit = groupSiblings([w('04:22:32:EE:AC:17', -60, { ch: 6 }), w('08:22:32:EE:AC:17', -61, { ch: 6 })]).length === 2;
                const g5 = groupSiblings([w('84:BB:69:CC:78:42', -50, { ch: 157 }), w('8A:BB:69:CC:78:42', -52, { ch: 157 }), w('84:BB:69:CC:78:41', -55, { ch: 1 })]);
                results.siblingRulesChain = g5.length === 1 && g5[0].members.length === 3 && g5[0].key === '84:BB:69:CC:78:41';
                results.unitLeadCategory = unitLead([w('AA:BB:CC:DD:EE:01', -40), w('AA:BB:CC:DD:EE:02', -70, { type: 'Flock Safety' })]).mac === 'AA:BB:CC:DD:EE:02' &&
                    unitLead([w('AA:BB:CC:DD:EE:01', -40), w('AA:BB:CC:DD:EE:02', -70)]).mac === 'AA:BB:CC:DD:EE:01';

                // Vendor: company ID wins, a public MAC falls back to its OUI,
                // a randomized address names nobody.
                const savedOui = ouiNames, savedBt = btNames;
                ouiNames = new Map([['001A11', 'Google'], ['021A11', 'WRONG'], ['98173C', 'Private']]);
                btNames = new Map([[76, 'Apple'], [1, 'Nokia']]);
                results.vendorLookup =
                    vendorOf({ mac: '00:1A:11:00:00:01', protocol: 'WiFi' }) === 'Google' &&
                    vendorOf({ mac: '02:1A:11:00:00:01', protocol: 'WiFi' }) === '' &&
                    vendorOf({ mac: '00:1A:11:00:00:01', protocol: 'BLE' }) === '' &&
                    vendorOf({ mac: '00:1A:11:00:00:01', protocol: 'BLE', pub: true }) === 'Google' &&
                    vendorOf({ mac: 'F2:00:00:00:00:01', protocol: 'BLE', cid: 76 }) === 'Apple' &&
                    vendorOf({ mac: 'F2:00:00:00:00:01', protocol: 'BLE', cid: 9999 }) === '' &&
                    // A registered OUI beats a self-declared (junk) company ID...
                    vendorOf({ mac: '00:1A:11:00:00:01', protocol: 'BLE', pub: true, cid: 1 }) === 'Google' &&
                    // ...but a "Private" registration names nobody, so fall back.
                    vendorOf({ mac: '98:17:3C:00:00:01', protocol: 'BLE', pub: true, cid: 76 }) === 'Apple';
                ouiNames = savedOui; btNames = savedBt;

                // A category chip says what its alert will actually do. The
                // buzzer mute is sound only, so with sound off a row must read
                // lights-only, not ON (as if it beeps) nor Off (as if it's dark).
                results.alertChip =
                    alertChip(true, true, 3) === '🔊 💡' &&
                    alertChip(true, false, 3) === '💡' &&
                    alertChip(true, true, 0) === '🔊' &&
                    alertChip(true, false, 0) === 'Silent' &&
                    alertChip(false, true, 3) === 'Off' &&
                    alertChip(null, true, 3) === '—' &&
                    alertChip(true, null, null) === '🔊 💡';

                results.themeNote =
                    themeNote(4, 3).startsWith('Party') &&
                    themeNote(4, 2).startsWith('Party') &&
                    themeNote(4, 1).startsWith('One LED') &&
                    themeNote(4, 0) === '' &&
                    themeNote(2, 1).startsWith('One LED') &&
                    themeNote(0, 1) === '' &&
                    themeNote(2, 3) === '' &&
                    themeNote(null, 1) === '';

                // Ring only where the firmware heard Immediate Alert / Link Loss
                // advertised: never on Wi-Fi, never on an AirTag.
                const wifiOnly = actionRow(liveMatches['CC:00:03'], categoryOf(''));
                const airtag = actionRow(liveMatches['CC:00:04'], categoryOf('Tracker'));
                const fob = actionRow({ mac: 'CC:00:09', protocol: 'BLE', ring: true }, categoryOf('Tracker'));
                results.noRingOnWifi = wifiOnly.indexOf('data-act="ring"') === -1 &&
                                       wifiOnly.indexOf('data-act="hunt"') > 0;
                results.noRingOnAirtag = airtag.indexOf('data-act="ring"') === -1 &&
                                         airtag.indexOf('data-act="hunt"') > 0;
                results.ringOnFob = fob.indexOf('data-act="ring"') > 0;

                // The hunted row is pinned to the top of the list even when it
                // is the weakest thing on screen -- the instrument is up there
                // and you should not have to scroll to the card it describes.
                huntMac = 'CC:00:04';
                results.huntPinnedTop = liveRows('all')[0].mac === 'CC:00:04' &&
                                        liveRows('all').length === 4;
                // The 4 Hz hunt frame feeds the trace without disturbing the
                // list: no new rows, no re-render of the thing under your thumb.
                huntTrace = [];
                const beforeKeys = Object.keys(liveMatches).length;
                processIncomingData('{"hunt":"CC:00:04","hunt_rssi":-52}');
                results.huntFrameFeedsTrace = huntTrace.length === 1 &&
                                              huntTrace[0].rssi === -52 &&
                                              liveMatches['CC:00:04'].rssi === -52 &&
                                              Object.keys(liveMatches).length === beforeKeys;
                huntMac = ''; huntTrace = [];

                // Same-box siblings render as one row with a "N radios" chip
                // and an expand control, not two separate rows. Proven
                // against real captured HTML -- the selftest.js stub makes
                // document.getElementById always return null, which would
                // let this assertion pass even if renderScope() were
                // completely broken, so swap in a capturing stand-in for
                // 'targets-list' only, for the duration of this block.
                foxhuntMode = true;
                // Isolate from every earlier test's leftover liveMatches --
                // foxhuntMode true means they'd all render too and inflate
                // the row count this block checks.
                const savedLiveMatches = liveMatches;
                liveMatches = {};
                // :20 carries a real category (rank 2) so it is unambiguously
                // the lead by unitLead's rule regardless of list order; :22
                // matches nothing (rank 0), which is what lets the hunted-
                // non-lead case below be constructed on purpose rather than
                // by the accident of hunt-pinning reordering the group.
                ingestTargets([
                    { mac: 'DD:EE:FF:00:11:20', rssi: -45, protocol: 'WiFi', ch: 6, type: 'Flock Safety', confidence: 90 },
                    { mac: 'DD:EE:FF:00:11:22', rssi: -60, protocol: 'WiFi', ch: 36 }
                ]);
                const groupKey = 'DD:EE:FF:00:11:20';   // prefix + the group's own lowest last octet
                const units = groupSiblings(liveRows('all')).filter(function (u) { return u.key === groupKey; });
                const origGetElementById = document.getElementById;
                const captured = { innerHTML: '' };
                const capturedCount = { textContent: '' };
                const capturedNAll = { textContent: '' };
                document.getElementById = function (id) {
                    if (id === 'targets-list') return captured;
                    if (id === 'scope-count') return capturedCount;
                    if (id === 'n-all') return capturedNAll;
                    return origGetElementById(id);
                };
                try {
                    renderScope();
                    const html1 = captured.innerHTML;
                    const pairRowCount = (html1.match(/class="scope-row/g) || []).length;
                    results.groupRendersOnce = units.length === 1 && units[0].members.length === 2 &&
                        html1.indexOf('<span class="radio-badge nradios">2 radios</span>') >= 0 &&
                        html1.indexOf('data-group="' + groupKey + '"') >= 0 &&
                        pairRowCount === 1;
                    // Header/band counts count units, not radios -- a two-
                    // radio box is one thing on screen, not two, through the
                    // same 'scope-count'/'n-all' elements renderScope() paints.
                    results.groupCountsUnits = capturedCount.textContent === 1 && capturedNAll.textContent === 1;

                    // Expanding shows both members with their own actions.
                    expandedGroups.add(groupKey);
                    renderScope();
                    const html2 = captured.innerHTML;
                    results.groupExpands = html2.indexOf('group-members') >= 0 &&
                        html2.indexOf('DD:EE:FF:00:11:20') >= 0 &&
                        html2.indexOf('DD:EE:FF:00:11:22') >= 0;
                    expandedGroups.delete(groupKey);

                    // A hunted member that is NOT the group's lead still
                    // pins the outline to the row -- the lead here is the
                    // Flock-typed, matched ':20' (a real category beats no
                    // match regardless of signal), so hunting ':22' exercises
                    // the non-lead path.
                    huntMac = 'DD:EE:FF:00:11:22';
                    renderScope();
                    results.groupHuntedOutline = /class="scope-row[^"]*\bhunted\b/.test(captured.innerHTML);
                    // While a hunt holds the group open, the expand toggle
                    // (which would do nothing) must not be offered.
                    results.groupHuntNoToggle = captured.innerHTML.indexOf('data-act="expand"') === -1;
                    huntMac = '';

                    // The group row's title borrows an SSID from any member
                    // that has one -- the lead is picked for category, and
                    // 44% of 5 GHz-only transmitters never send an SSID of
                    // their own, so a lead with none must not title the row
                    // by bare MAC when a sibling can name it.
                    liveMatches = {};
                    ingestTargets([
                        { mac: 'DD:EE:FF:00:12:30', rssi: -45, protocol: 'WiFi', ch: 6, type: 'Flock Safety', confidence: 90 },
                        { mac: 'DD:EE:FF:00:12:32', rssi: -60, protocol: 'WiFi', ch: 36, ssid: 'GuestNet' }
                    ]);
                    captured.innerHTML = '';
                    renderScope();
                    results.groupSsidFromMember = captured.innerHTML.indexOf('GuestNet') >= 0;

                    // The group row's signal is the strongest member's, not
                    // the lead's -- the lead can be the weaker radio of the
                    // pair (chosen for category, not signal).
                    liveMatches = {};
                    ingestTargets([
                        { mac: 'DD:EE:FF:00:13:30', rssi: -70, protocol: 'WiFi', ch: 6, type: 'Flock Safety', confidence: 90 },
                        { mac: 'DD:EE:FF:00:13:32', rssi: -30, protocol: 'WiFi', ch: 36 }
                    ]);
                    captured.innerHTML = '';
                    renderScope();
                    results.groupRssiStrongest = captured.innerHTML.indexOf('-30 dBm') >= 0 &&
                        captured.innerHTML.indexOf('-70 dBm') === -1;
                } finally {
                    document.getElementById = origGetElementById;
                }
                liveMatches = savedLiveMatches;
                foxhuntMode = false;

                // Ordering is bucketed to 5 dB so multipath jitter cannot swap
                // two rows under a thumb that is already reaching for one.
                liveMatches = {};
                ingestTargets([
                    { mac: 'DD:00:02', rssi: -60, confidence: 80, type: 'Tracker' },
                    { mac: 'DD:00:01', rssi: -62, confidence: 80, type: 'Tracker' }
                ]);
                const order1 = liveRows('all').map(function (m) { return m.mac; }).join();
                liveMatches['DD:00:02'].rssi = -63;   // jitter, same bucket
                results.orderStableUnderJitter =
                    order1 === 'DD:00:01,DD:00:02' &&
                    liveRows('all').map(function (m) { return m.mac; }).join() === order1;

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
                // Photo bytes encrypt->decrypt on the same PIN key (the camera
                // evidence path). Includes high bytes to catch any text mangling.
                const photoBytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255, 128, 64]);
                const encP = await encryptBytes(photoBytes);
                const decP = await decryptBytes(encP);
                // A real camera photo is megabytes; the tiny case above never
                // tripped the old spread-based b64() that overflowed at ~0.5 MB.
                const bigPhoto = new Uint8Array(3 * 1048576).map((_, i) => (i * 131) & 0xff);
                let bigOk = false;
                try {
                    const back = await decryptBytes(unb64(b64(await encryptBytes(bigPhoto))));
                    bigOk = back.length === bigPhoto.length && back.every((b, i) => b === bigPhoto[i]);
                } catch (e) {}
                results.photoRoundTrip = decP.length === photoBytes.length &&
                                         decP.every((b, i) => b === photoBytes[i]) && bigOk;
                // Wrong PIN reveals nothing
                pinKey = null; pinsCache = [];
                let wrongFailed = false;
                try { await unlockPins('9999'); } catch (e) { wrongFailed = true; }
                results.wrongPinRejected = wrongFailed && pinsCache.length === 0;

                // Finds persist in the same encrypted store as pins.
                await createPinStore('1234');
                findsCache.push({ id: 'f1', category: 'ALPR / Camera', signature: { label: 'Flock IE', sampleMac: 'aa:bb' }, photo: null, capture: 'c.sscap', lat: null, lng: null, acc: null, ts: 1 });
                pinsCache.push({ mac: 'PP', category: 'ALPR / Camera', lat: 1, lng: 2, acc: 5, ts: 1 });
                await savePins();
                pinKey = null; pinsCache = []; findsCache = [];
                await unlockPins('1234');
                results.findsRoundTrip = findsCache.length === 1 && findsCache[0].signature.label === 'Flock IE' && pinsCache.length === 1;
                // Only confirmed cameras with a fix become OSM nodes.
                results.findOsmTags =
                    findOsmNode({ category: 'ALPR / Camera', lat: 1, lng: 2 }, 0, 's', '').indexOf('surveillance:type" v="ALPR"') > 0 &&
                    findOsmNode({ category: 'Surveillance Camera', lat: 1, lng: 2 }, 0, 's', '').indexOf('surveillance:type" v="camera"') > 0 &&
                    findOsmNode({ category: 'Unconfirmed', lat: 1, lng: 2 }, 0, 's', '') === '' &&
                    findOsmNode({ category: 'ALPR / Camera', lat: null, lng: null }, 0, 's', '') === '' &&
                    categoryOf('ALPR / Camera').key === 'alpr' && categoryOf('Surveillance Camera').key === 'alpr';

                // v1 store (a bare pins array) still unlocks; finds default to [].
                {
                    const salt = crypto.getRandomValues(new Uint8Array(16));
                    const key = await deriveKey('1234', salt);
                    const iv = crypto.getRandomValues(new Uint8Array(12));
                    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
                        new TextEncoder().encode(JSON.stringify([{ mac: 'OLD', lat: 1, lng: 2, acc: 3, ts: 1, category: 'x' }])));
                    localStorage.setItem(PIN_STORE_KEY, JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
                    pinKey = null; pinsCache = []; findsCache = [];
                    await unlockPins('1234');
                    results.v1Migration = pinsCache.length === 1 && pinsCache[0].mac === 'OLD' && findsCache.length === 0;
                }

                // Alert log: a hand-built 16-byte record, laid out exactly as
                // firmware/src/alert_log.h packs it, must decode to the values
                // that went in. A byte off here is the Remote ID offset bug all
                // over again -- every field wrong, nothing visibly broken.
                {
                    const rec = new Uint8Array(16);
                    rec[0] = 0x07; rec[1] = 0x00;                       // boot 7
                    rec[2] = 0x2C; rec[3] = 0x01; rec[4] = 0; rec[5] = 0; // secs 300
                    [0xA4, 0x11, 0x22, 0x33, 0x44, 0x55].forEach((b, i) => { rec[6 + i] = b; });
                    rec[12] = 0;      // ALERT_ALPR
                    rec[13] = 1;      // second name in the table
                    rec[14] = 0xBD;   // -67 as int8
                    const got = parseLogRecords([rec], ['other rule', 'Flock probe + IE']);
                    const r = got[0];
                    results.logRecordDecode = got.length === 1 && r.boot === 7 && r.secs === 300 &&
                        r.mac === 'A4:11:22:33:44:55' && r.cat === 0 &&
                        r.rule === 'Flock probe + IE' && r.rssi === -67;

                    // Two records in one chunk, and a rule index past the end of
                    // the table (a log written before a name was recorded) must
                    // degrade to an empty name rather than throw.
                    const two = new Uint8Array(32);
                    two.set(rec, 0); two.set(rec, 16); two[16 + 13] = 255;
                    const pair = parseLogRecords([two], ['only one']);
                    results.logRecordChunking = pair.length === 2 && pair[1].rule === '';

                    // The summary is the payoff of a session: counts by category
                    // and distinct devices, not total beeps.
                    const sum = logSummary([
                        { mac: 'AA', cat: 0 }, { mac: 'AA', cat: 0 },
                        { mac: 'BB', cat: 3 }, { mac: 'CC', cat: 2 }
                    ]);
                    results.logSummaryCounts = sum.total === 4 && sum.devices === 3 &&
                        sum.by['ALPR / Camera'] === 2 && sum.by['Tracker'] === 1 &&
                        sum.by['Drone'] === 1;

                    // A boot this phone never saw has no wall clock -- the board
                    // has no RTC. Say where in that boot it was; never invent a date.
                    const saved = logBootEpochs;
                    logBootEpochs = {};
                    const undated = logLine(r);
                    logBootEpochs = { 7: Date.parse('2026-09-19T12:00:00') };
                    const dated = logLine(r);
                    logBootEpochs = saved;
                    results.logLineUndatedBoot = undated.indexOf('boot 7 +300s') === 0 &&
                        undated.indexOf('A4:11:22:33:44:55') > 0 && undated.indexOf('-67') > 0;
                    results.logLineDatedBoot = dated.indexOf('2026-09-19 12:05:00') === 0;
                }

                // The on-phone analyzer finds the exact Flock fingerprint in a
                // hand-built probe-request record (same wire format as the board).
                // Flags only under the detector's rule: the same wildcard probe +
                // IE is a Flock match from a listed OUI, and nothing from the China
                // Dragon module that tripped the bench.
                {
                    const probe = (mac) => {
                        const frame = [0x40, 0x00, 0, 0].concat([0xff,0xff,0xff,0xff,0xff,0xff])
                            .concat(mac).concat([0xff,0xff,0xff,0xff,0xff,0xff])
                            .concat([0, 0, 0, 0])   // seq + wildcard SSID IE (id0 len0)
                            .concat([221, 7, 0x50, 0x6f, 0x9a, 0x16, 0x03, 0x01, 0x03]);
                        const hdr = [0, 1,0,0,0, 0,0,0,0, 6, (-30)&0xff, frame.length & 0xff, (frame.length>>8)&0xff, frame.length & 0xff, (frame.length>>8)&0xff];
                        return analyzeCaptureText('#SSCAP\n' + b64(new Uint8Array(hdr.concat(frame))) + '\n');
                    };
                    const flock = probe([0xb4, 0x1e, 0x52, 0x53, 0x53, 0x01]);
                    const chinaDragon = probe([0x1c, 0x79, 0x2d, 0xe5, 0x93, 0x25]);
                    const randomMac = probe([0x6a, 0x03, 0xca, 0x5b, 0x77, 0x77]);
                    results.analyzerFlock = flock.flockDetected && flock.flockMacs === 1 && flock.signature.type === 'flock-ie' &&
                                            !chinaDragon.flockDetected && !randomMac.flockDetected;
                }
                return results;
            };
        }
