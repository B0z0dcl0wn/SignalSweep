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

        // One GPS fix. `acc` is the reported accuracy radius in metres and is
        // load-bearing: an urban-canyon fix can be 100 m+ off, and a bad fix that
        // seeds a cluster becomes the coordinate we would publish to OSM.
        function onGpsFix(coords) {
            globalPhoneLocation = {
                lat: coords.latitude,
                lng: coords.longitude,
                acc: (coords.accuracy == null ? 9999 : coords.accuracy)
            };
            noteVisitEpoch(globalPhoneLocation);

            if (currentActiveMode === 2 && map && polyline) {
                const latlng = [coords.latitude, coords.longitude];
                // Only extend the trail once we've actually moved. Appending
                // every fix let a stationary phone with jittery GPS grow this
                // array without bound.
                const last = warFlockingPath[warFlockingPath.length - 1];
                if (!last || haversineM({ lat: last[0], lng: last[1] },
                                        { lat: latlng[0], lng: latlng[1] }) > 10) {
                    warFlockingPath.push(latlng);
                    polyline.setLatLngs(warFlockingPath);
                }
                map.setView(latlng);
            }
        }

        function initGPS() {
            if (gpsInitialized) return;
            if (window.Geolocation) {
                window.Geolocation.requestPermissions().then((status) => {
                    if (status.location === 'granted' || status.coarseLocation === 'granted') {
                        gpsInitialized = true;
                        window.Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
                            if (pos) onGpsFix(pos.coords);
                        });
                    } else {
                        console.error('Geolocation permission denied');
                        showToast('Location permission denied!', '✕');
                    }
                }).catch(err => console.error(err));
            } else if (navigator.geolocation) {
                // Browser fallback. window.Geolocation only exists in the
                // Capacitor build, so without this every geo feature (the map
                // trail, the fixed/mobile classifier, true-bearing radar) was
                // silently inert during `npm run dev`.
                gpsInitialized = true;
                navigator.geolocation.watchPosition(
                    (pos) => onGpsFix(pos.coords),
                    (err) => console.error('Geolocation error', err),
                    { enableHighAccuracy: true }
                );
            }
        }

        // Escape untrusted text before it goes into innerHTML. Device names,
        // SSIDs and GATT ASCII values are chosen by the device being observed —
        // i.e. by exactly the hostile hardware this app exists to point at — so
        // none of it may reach the DOM as markup.
        function esc(v) {
            if (v == null) return '';
            return String(v).replace(/[&<>"']/g, (c) => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        }

        let gattProfileCache = {};
        let lastBanditData = null;

        // ---- Shared sighting store ---------------------------------------
        // The device reports what it hears; the phone knows where it is. Every
        // mode's telemetry lands in ONE store, and the two questions this
        // project actually asks are two queries against it:
        //
        //   seen in many separate places      -> mobile   (something tailing you)
        //   seen in ONE place, on many visits -> fixed    (bolted to a pole)
        //
        // The "fixed" test is why Watcher's Watch no longer depends on the
        // signature list to find a camera: a pole-mounted radio has a
        // distinctive geospatial signature no matter who made it. Signature
        // matches now ride along as corroboration and labelling only.
        const SIGHT_CLUSTER_M       = 200;   // >200 m apart = a different place
        const SIGHT_ACCURACY_MAX_M  = 50;    // ignore fixes vaguer than this
        const SIGHT_FIXED_VISITS    = 2;     // visits to one place that confirm infrastructure
        const SIGHT_ALERT_CLUSTERS  = 3;     // places that escalate a tail to "following you"
        const SIGHT_STORE_KEY       = 'sightStore';
        const SIGHT_PRUNE_SINGLE_MS = 24 * 60 * 60 * 1000;       // one-hit wonders: 24 h
        const SIGHT_PRUNE_STALE_MS  = 30 * 24 * 60 * 60 * 1000;  // anything at all: 30 d

        // mac -> { clusters:[{lat,lng,n,visits,epoch}], first,last,count,rssi,name,proto,conf,rule,tier }
        let sightStore = {};

        function haversineM(a, b) {
            const R = 6371000, toRad = d => d * Math.PI / 180;
            const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
            const s = Math.sin(dLat / 2) ** 2 +
                      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(s));
        }

        // A "visit" is you leaving and coming back, not you lingering. Sitting in
        // a cafe for an hour must count once, or every radio in the building
        // would confirm as infrastructure. Rather than re-measure every cluster
        // on every fix, count the phone's own travel: each time YOU move more
        // than a cluster radius, the epoch ticks. A device heard in epoch 5 and
        // again in epoch 40 was seen on two separate visits; one heard only
        // while you sat still stays on one.
        let visitEpoch = 0;
        let visitEpochOrigin = null;

        function noteVisitEpoch(loc) {
            if (!loc || loc.acc > SIGHT_ACCURACY_MAX_M) return;
            if (!visitEpochOrigin) { visitEpochOrigin = loc; return; }
            if (haversineM(visitEpochOrigin, loc) > SIGHT_CLUSTER_M) {
                visitEpoch++;
                visitEpochOrigin = loc;
            }
        }

        // Fold one sighting into a device's record. Returns the updated record.
        function sightRecord(store, mac, loc, now, extra) {
            const rec = store[mac] || { clusters: [], first: now, last: now, count: 0,
                                        rssi: -99, name: '', proto: '', conf: 0, rule: '', tier: '' };
            rec.last = now;
            rec.count++;
            if (extra) {
                if (extra.rssi != null) rec.rssi = extra.rssi;
                if (extra.name)  rec.name  = extra.name;
                if (extra.proto) rec.proto = extra.proto;
                if (extra.rule)  rec.rule  = extra.rule;
                if (extra.tier)  rec.tier  = extra.tier;
                if (extra.conf != null && extra.conf > (rec.conf || 0)) rec.conf = extra.conf;
            }

            // A vague fix is worse than no fix: it silently smears a cluster,
            // and the centroid is the coordinate we would publish to OSM.
            if (loc && loc.lat != null && loc.lng != null && loc.acc <= SIGHT_ACCURACY_MAX_M) {
                let hit = null;
                for (const c of rec.clusters) {
                    if (haversineM(c, loc) <= SIGHT_CLUSTER_M) { hit = c; break; }
                }
                if (hit) {
                    // Re-centre as a running mean. Clusters used to be seed
                    // points that never moved, so one bad early fix anchored a
                    // camera to the wrong corner permanently.
                    hit.lat = (hit.lat * hit.n + loc.lat) / (hit.n + 1);
                    hit.lng = (hit.lng * hit.n + loc.lng) / (hit.n + 1);
                    hit.n++;
                    if (hit.epoch !== visitEpoch) { hit.visits++; hit.epoch = visitEpoch; }
                } else {
                    rec.clusters.push({ lat: loc.lat, lng: loc.lng, n: 1, visits: 1, epoch: visitEpoch });
                }
            }
            store[mac] = rec;
            return rec;
        }

        // Kept under its old name because Shadow and the self-test call it.
        function shadowRecord(store, mac, loc, now, extra) {
            return sightRecord(store, mac, loc, now, extra);
        }

        // The whole classifier. Two branches, one store.
        function classify(rec) {
            if (!rec || !rec.clusters) return 'candidate';
            if (rec.clusters.length >= 2) return 'mobile';
            if (rec.clusters.length === 1 && rec.clusters[0].visits >= SIGHT_FIXED_VISITS) return 'fixed';
            return 'candidate';
        }

        // 0-100 for the mobile branch. Distinct places dominate; span of time
        // and total distance help.
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

        // ---- Persistence --------------------------------------------------
        // Confirming a fixed installation takes repeat visits, which means days,
        // which means the store has to outlive the process. Randomized MACs never
        // earn a second visit, so pruning them keeps this in the hundreds of
        // records rather than the thousands, and localStorage stays viable.
        // ponytail: move to IndexedDB only if this actually overflows.
        function sightPrune(store, now) {
            let dropped = 0;
            for (const mac of Object.keys(store)) {
                const rec = store[mac];
                // A confirmed installation is the OUTPUT of the whole system, not
                // cache. Expiring one on a timer un-detects a camera that already
                // cost two visits to find, and it has to earn them again from
                // scratch. There are only ever a handful; keep them for ever.
                if (classify(rec) === 'fixed') continue;
                const age = now - (rec.last || 0);
                if (age > SIGHT_PRUNE_STALE_MS ||
                    ((rec.count || 0) <= 1 && age > SIGHT_PRUNE_SINGLE_MS)) {
                    delete store[mac];
                    dropped++;
                }
            }
            return dropped;
        }

        function sightStoreLoad() {
            try {
                const raw = JSON.parse(localStorage.getItem(SIGHT_STORE_KEY) || '{}');
                sightStore = (raw && typeof raw === 'object') ? raw : {};
            } catch (e) { sightStore = {}; }
            sightPrune(sightStore, Date.now());
        }

        // Drop the n least valuable records. Order is by WHAT A RECORD IS, never
        // by how chatty it is: this used to sort on `count` and delete the
        // weakest half, but `count` measures talkativeness, not interest. A
        // slow-beaconing ALPR caught on two drive-bys sits at count 6 while a
        // neighbour's smart TV sits at 4000 — so that eviction kept the TV and
        // deleted the camera. It is the same mistake the firmware's report cap
        // is forbidden from making with RSSI (see CLAUDE.md), one layer up.
        // Unclassified candidates go first, stalest first; findings go last.
        // Returns the victims so the caller can tell if a finding was lost.
        function sightEvict(store, n) {
            const rank = { candidate: 0, mobile: 1, fixed: 2 };
            const victims = Object.keys(store)
                .map(mac => ({ mac, kind: classify(store[mac]), last: store[mac].last || 0 }))
                .sort((a, b) => (rank[a.kind] - rank[b.kind]) || (a.last - b.last))
                .slice(0, n);
            victims.forEach(v => delete store[v.mac]);
            return victims;
        }

        // The actual write. Separate from the throttle so an import can force one.
        let sightFindingsLost = false;
        function sightWrite() {
            try {
                localStorage.setItem(SIGHT_STORE_KEY, JSON.stringify(sightStore));
                return true;
            } catch (e) {
                console.warn('sightStore write failed, evicting', e);
            }
            // Shed a quarter at a time until it fits, rather than binning half the
            // store on the first stumble.
            for (let tries = 0; tries < 8; tries++) {
                const n = Object.keys(sightStore).length;
                if (!n) break;
                const lost = sightEvict(sightStore, Math.max(1, Math.ceil(n / 4)));
                if (!sightFindingsLost && lost.some(v => v.kind !== 'candidate')) {
                    // Silently discarding a confirmed detection is the one outcome
                    // worth interrupting the user for.
                    sightFindingsLost = true;
                    try { showToast('Storage full — confirmed detections dropped. Export a backup.', '✕'); } catch (e) {}
                }
                try {
                    localStorage.setItem(SIGHT_STORE_KEY, JSON.stringify(sightStore));
                    return true;
                } catch (e2) { /* still too big; shed again */ }
            }
            return false;
        }

        let sightSaveTimer = null;
        function sightStoreSave() {
            if (sightSaveTimer) return;          // throttle: at most one write per 10 s
            sightSaveTimer = setTimeout(() => {
                sightSaveTimer = null;
                sightWrite();
            }, 10000);
        }

        // ponytail: runnable self-check for the store, the visit logic, the
        // classifier and the escaper. window.__sightStoreSelfTest() in the
        // console, or `node app/selftest.js`, returns true if sane.
        function __sightStoreSelfTest() {
            const results = {};
            const A = { lat: 30.2200, lng: -92.0200, acc: 10 };   // origin
            const B = { lat: 30.2400, lng: -92.0200, acc: 10 };   // ~2.2 km north
            const C = { lat: 30.2600, lng: -92.0200, acc: 10 };   // ~4.4 km north

            const savedEpoch = visitEpoch, savedOrigin = visitEpochOrigin;
            const reset = () => { visitEpoch = 0; visitEpochOrigin = null; };

            // 1. Lingering in one place is ONE visit, however many hits.
            reset();
            let s1 = {};
            for (let i = 0; i < 50; i++) {
                noteVisitEpoch(A);
                sightRecord(s1, 'AA', A, i * 1000, { rssi: -50 });
            }
            results.lingerVisits = s1['AA'].clusters[0].visits;      // expect 1
            results.lingerKind = classify(s1['AA']);                 // expect 'candidate'

            // 2. Leave and come back -> a second visit -> 'fixed'.
            reset();
            let s2 = {};
            noteVisitEpoch(A); sightRecord(s2, 'CAM', A, 0, { rssi: -70 });
            noteVisitEpoch(B);                       // travelled away: epoch ticks
            noteVisitEpoch(A);                       // came back: ticks again
            sightRecord(s2, 'CAM', A, 3600000, { rssi: -70 });
            results.returnVisits = s2['CAM'].clusters[0].visits;     // expect 2
            results.returnClusters = s2['CAM'].clusters.length;      // expect 1
            results.returnKind = classify(s2['CAM']);                // expect 'fixed'

            // 3. Heard in several distinct places -> mobile, not fixed.
            reset();
            let s3 = {};
            noteVisitEpoch(A); sightRecord(s3, 'TAIL', A, 0, { rssi: -60 });
            noteVisitEpoch(B); sightRecord(s3, 'TAIL', B, 600000, { rssi: -65 });
            noteVisitEpoch(C); sightRecord(s3, 'TAIL', C, 1200000, { rssi: -62 });
            results.tailClusters = s3['TAIL'].clusters.length;       // expect 3
            results.tailKind = classify(s3['TAIL']);                 // expect 'mobile'
            results.tailScore = shadowScore(s3['TAIL'], 1200000);    // expect > 0

            // 4. A vague fix must not place a device at all.
            reset();
            let s4 = {};
            sightRecord(s4, 'VAGUE', { lat: 30.22, lng: -92.02, acc: 500 }, 0, { rssi: -60 });
            results.vagueClusters = s4['VAGUE'].clusters.length;     // expect 0
            results.vagueKind = classify(s4['VAGUE']);               // expect 'candidate'

            // 5. Centroid re-centres toward the mean instead of sticking to the
            //    first (possibly bad) fix.
            reset();
            let s5 = {};
            sightRecord(s5, 'DRIFT', { lat: 30.0000, lng: -92.0000, acc: 10 }, 0, {});
            sightRecord(s5, 'DRIFT', { lat: 30.0010, lng: -92.0000, acc: 10 }, 1, {});
            results.centroidLat = s5['DRIFT'].clusters[0].lat;       // expect ~30.0005
            results.centroidMoved = Math.abs(s5['DRIFT'].clusters[0].lat - 30.0005) < 1e-6;

            // 6. Pruning drops one-hit wonders older than a day, keeps repeats.
            const now = Date.now();
            const s6 = {
                ONEHIT: { clusters: [], first: 0, last: now - 48 * 3600 * 1000, count: 1 },
                REPEAT: { clusters: [], first: 0, last: now - 48 * 3600 * 1000, count: 9 },
                ANCIENT: { clusters: [], first: 0, last: now - 40 * 24 * 3600 * 1000, count: 9 }
            };
            sightPrune(s6, now);
            results.prunedOneHit = !('ONEHIT' in s6);                // expect true
            results.keptRepeat = ('REPEAT' in s6);                   // expect true
            results.prunedAncient = !('ANCIENT' in s6);              // expect true

            // 6b. A confirmed installation must survive the stale prune: it is
            //     the answer, not cache.
            const s6b = {
                CAM: { clusters: [{ lat: 30.22, lng: -92.02, n: 4, visits: 2, epoch: 0 }],
                       first: 0, last: now - 60 * 24 * 3600 * 1000, count: 4 }
            };
            sightPrune(s6b, now);
            results.keptOldCamera = ('CAM' in s6b);                  // expect true

            // 6c. Eviction must drop a chatty candidate before a quiet camera.
            //     This is the bug: sorting on `count` did exactly the opposite.
            const s6c = {
                CHATTY: { clusters: [], first: 0, last: now, count: 5000 },
                CAM:    { clusters: [{ lat: 30.22, lng: -92.02, n: 3, visits: 2, epoch: 0 }],
                          first: 0, last: now, count: 3 }
            };
            sightEvict(s6c, 1);
            results.evictedChatty = !('CHATTY' in s6c);              // expect true
            results.evictKeptCamera = ('CAM' in s6c);                // expect true

            // 6d. A backup round-trips, and a re-import cannot inflate counters.
            const s6d = { CAM: { clusters: [{ lat: 30.22, lng: -92.02, n: 3, visits: 2, epoch: 0 }],
                                 first: 10, last: 20, count: 7, conf: 80, rssi: -70,
                                 name: 'n', proto: 'BLE', rule: 'r', tier: '' } };
            const backup = JSON.parse(JSON.stringify({ version: 1, sightStore: s6d,
                                                       shadowWhitelist: ['MINE'] }));
            const s6dLocal = {}, wl = new Set();
            sightMergeBackup(s6dLocal, wl, backup);
            sightMergeBackup(s6dLocal, wl, backup);        // twice: must be idempotent
            results.restoredCount = s6dLocal['CAM'].count;           // expect 7, not 14
            results.restoredVisits = s6dLocal['CAM'].clusters[0].visits;  // expect 2
            results.restoredKind = classify(s6dLocal['CAM']);        // expect 'fixed'
            results.restoredWhitelist = wl.has('MINE');              // expect true

            // 6e. A restore must not clobber sightings made since the backup.
            const s6e = { CAM: { clusters: [{ lat: 30.22, lng: -92.02, n: 9, visits: 5, epoch: 0 },
                                            { lat: 30.90, lng: -92.02, n: 2, visits: 1, epoch: 1 }],
                                 first: 5, last: 999, count: 99 } };
            sightMergeBackup(s6e, new Set(), backup);
            results.mergeKeptNewer = s6e['CAM'].count === 99 &&
                                     s6e['CAM'].clusters[0].visits === 5 &&
                                     s6e['CAM'].clusters.length === 2;

            // 6f. OSM cross-check: pair confirmed detections against mapped
            //     ALPR nodes. The outcome that matters is 'unmapped' — a fixed
            //     installation nobody has put on the map.
            const savedStore = sightStore, savedNodes = alprNodes, savedWl = shadowWhitelist;
            sightStore = {
                // ~30 m from the mapped node below: same installation.
                NEAR: { clusters: [{ lat: 30.22000, lng: -92.02000, n: 4, visits: 2, epoch: 0 }],
                        first: 0, last: 0, count: 4 },
                // ~2 km away: a fixed radio OSM has never heard of.
                FAR:  { clusters: [{ lat: 30.24000, lng: -92.02000, n: 4, visits: 2, epoch: 0 }],
                        first: 0, last: 0, count: 4 },
                // Not confirmed, so it must not appear at all.
                CAND: { clusters: [{ lat: 30.22000, lng: -92.02000, n: 1, visits: 1, epoch: 0 }],
                        first: 0, last: 0, count: 1 }
            };
            shadowWhitelist = new Set();
            alprNodes = [
                { id: 1, lat: 30.22025, lng: -92.02000, operator: 'Test PD' },   // ~28 m from NEAR
                { id: 2, lat: 30.30000, lng: -92.02000, operator: 'Unheard' }    // nowhere near anything
            ];
            const cc = alprCorroborate();
            results.alprPaired = cc.paired.length;                   // expect 2 (candidate excluded)
            results.alprCorroborated = cc.paired.filter(x => x.node).length;  // expect 1
            results.alprUnmapped = cc.unmapped.map(x => x.mac).join(',');     // expect 'FAR'
            results.alprMappedOnly = cc.mappedOnly.map(x => x.id).join(',');  // expect '2'
            // A corroborated pairing must never change the classification.
            results.alprNoPromotion = classify(sightStore.CAND) === 'candidate';
            sightStore = savedStore; alprNodes = savedNodes; shadowWhitelist = savedWl;

            // 7. A hostile device name cannot become markup.
            const evil = '<img src=x onerror="alert(1)">';
            results.escaped = esc(evil);
            results.escapedSafe = results.escaped.indexOf('<') === -1 &&
                                  results.escaped.indexOf('"') === -1;

            visitEpoch = savedEpoch; visitEpochOrigin = savedOrigin;

            const ok = results.lingerVisits === 1 &&
                       results.lingerKind === 'candidate' &&
                       results.returnVisits === 2 &&
                       results.returnClusters === 1 &&
                       results.returnKind === 'fixed' &&
                       results.tailClusters === 3 &&
                       results.tailKind === 'mobile' &&
                       results.tailScore > 0 &&
                       results.vagueClusters === 0 &&
                       results.vagueKind === 'candidate' &&
                       results.centroidMoved &&
                       results.prunedOneHit && results.keptRepeat && results.prunedAncient &&
                       results.keptOldCamera &&
                       results.evictedChatty && results.evictKeptCamera &&
                       results.restoredCount === 7 && results.restoredVisits === 2 &&
                       results.restoredKind === 'fixed' && results.restoredWhitelist &&
                       results.mergeKeptNewer &&
                       results.alprPaired === 2 && results.alprCorroborated === 1 &&
                       results.alprUnmapped === 'FAR' && results.alprMappedOnly === '2' &&
                       results.alprNoPromotion &&
                       results.escapedSafe;

            results.ok = ok;
            console.log('[sightStore self-test]', results);
            return ok;
        }
        if (typeof window !== 'undefined') window.__sightStoreSelfTest = __sightStoreSelfTest;

        // Field-debugging helper: what does the store actually think right now?
        // window.__sightDump()        -> everything, worst-to-best
        // window.__sightDump('fixed') -> just the confirmed installations
        function __sightDump(kind) {
            const rows = Object.entries(sightStore).map(([mac, rec]) => ({
                mac,
                kind: classify(rec),
                places: rec.clusters.length,
                visits: rec.clusters.length === 1 ? rec.clusters[0].visits : '-',
                hits: rec.count,
                rssi: rec.rssi,
                proto: rec.proto,
                name: rec.name,
                conf: rec.conf,
                rule: rec.rule,
                mine: shadowWhitelist.has(mac),
                at: rec.clusters.length === 1
                    ? rec.clusters[0].lat.toFixed(5) + ',' + rec.clusters[0].lng.toFixed(5) : ''
            })).filter(r => !kind || r.kind === kind);
            console.table(rows.sort((a, b) => b.hits - a.hits));
            console.log('epoch=' + visitEpoch + ' (ticks each time YOU move >' + SIGHT_CLUSTER_M + ' m)',
                        'stored=' + Object.keys(sightStore).length,
                        'gps=', globalPhoneLocation);
            return rows.length;
        }
        if (typeof window !== 'undefined') window.__sightDump = __sightDump;

        // Ingest one telemetry batch from any mode into the shared store.
        function sightIngest(targets, protoDefault) {
            const now = Date.now();
            const loc = globalPhoneLocation;
            (targets || []).forEach(t => {
                const mac = t.mac || '??';
                if (shadowWhitelist.has(mac)) return;
                sightRecord(sightStore, mac, loc, now, {
                    rssi: t.rssi,
                    name: t.name,
                    proto: t.protocol || protoDefault,
                    conf: t.confidence,
                    rule: t.matched_rule,
                    tier: t.tier
                });
            });
            sightStoreSave();
        }

        // Whitelist: your own gear (car AP, phone, earbuds) travels every place
        // you do, so it always scores as a "tail" — and your home router sits at
        // exactly one place you keep returning to, so it always confirms as
        // "fixed". Marking it yours once suppresses it in BOTH branches, which
        // is why the whitelist lives with the shared store rather than in
        // Shadow. Per-viewer, persisted on the phone.
        let shadowWhitelist = new Set();
        try { shadowWhitelist = new Set(JSON.parse(localStorage.getItem('shadowWhitelist') || '[]')); } catch (e) {}

        function shadowWhitelistSave() {
            try { localStorage.setItem('shadowWhitelist', JSON.stringify([...shadowWhitelist])); } catch (e) {}
        }
        function shadowWhitelistAdd(mac) {
            shadowWhitelist.add(mac);
            delete sightStore[mac];          // drop its history so it stops scoring
            shadowWhitelistSave();
            sightStoreSave();
            showToast('Marked as yours — hidden from now on', '✓');
            if (currentActiveMode === 4) shadowRenderList();
            else if (currentActiveMode === 2) watchersRenderList();
        }
        function shadowWhitelistClear() {
            shadowWhitelist.clear();
            shadowWhitelistSave();
            showToast('Whitelist cleared', '✓');
            if (currentActiveMode === 4) shadowRenderList();
            else if (currentActiveMode === 2) watchersRenderList();
        }
        window.shadowWhitelistAdd = shadowWhitelistAdd;
        window.shadowWhitelistClear = shadowWhitelistClear;

        // ---- Backup / restore ---------------------------------------------
        // Confirming a fixed installation takes repeat visits across days, so
        // weeks of history IS the detector — and all of it lives in one
        // localStorage key on one phone. "Clear data", a reinstall or a new
        // handset erases every confirmed detection. A file you can copy is the
        // whole fix; the sibling project's advantage over us was never that its
        // store was relational, only that it was on disk.
        const SIGHT_BACKUP_VERSION = 1;

        // Merge one imported record into the local one. Neither side is
        // authoritative: the backup holds visits this phone has forgotten, the
        // phone holds sightings made since the backup. Union the clusters and
        // take the best of each counter — max, never sum, so re-importing the
        // same file twice cannot inflate a device into a false 'fixed'.
        function sightMergeRecord(local, incoming) {
            if (!local) return JSON.parse(JSON.stringify(incoming));
            if (!incoming) return local;
            const out = Object.assign({}, local);
            out.first = Math.min(local.first || incoming.first || 0,
                                 incoming.first || local.first || 0);
            out.last  = Math.max(local.last || 0, incoming.last || 0);
            out.count = Math.max(local.count || 0, incoming.count || 0);
            out.conf  = Math.max(local.conf || 0, incoming.conf || 0);
            out.rssi  = Math.max(local.rssi == null ? -99 : local.rssi,
                                 incoming.rssi == null ? -99 : incoming.rssi);
            out.name  = local.name  || incoming.name  || '';
            out.proto = local.proto || incoming.proto || '';
            out.rule  = local.rule  || incoming.rule  || '';
            out.tier  = local.tier  || incoming.tier  || '';
            out.clusters = (local.clusters || []).map(c => Object.assign({}, c));
            (incoming.clusters || []).forEach(ic => {
                if (ic == null || ic.lat == null || ic.lng == null) return;
                const hit = out.clusters.find(c => haversineM(c, ic) <= SIGHT_CLUSTER_M);
                if (hit) {
                    hit.visits = Math.max(hit.visits || 1, ic.visits || 1);
                    hit.n      = Math.max(hit.n || 1, ic.n || 1);
                } else {
                    out.clusters.push(Object.assign({}, ic));
                }
            });
            return out;
        }

        // A backup file is user-supplied: validate the shape, skip junk records,
        // and never let a malformed file wipe the live store.
        function sightMergeBackup(store, whitelist, payload) {
            if (!payload || typeof payload !== 'object' ||
                !payload.sightStore || typeof payload.sightStore !== 'object') {
                throw new Error('not a SignalSweep backup');
            }
            let added = 0, merged = 0;
            for (const [mac, rec] of Object.entries(payload.sightStore)) {
                if (!rec || typeof rec !== 'object' || !Array.isArray(rec.clusters)) continue;
                if (store[mac]) merged++; else added++;
                store[mac] = sightMergeRecord(store[mac], rec);
            }
            if (Array.isArray(payload.shadowWhitelist)) {
                payload.shadowWhitelist.forEach(m => { if (typeof m === 'string') whitelist.add(m); });
            }
            return { added, merged };
        }

        function exportSightStore() {
            // The whitelist ships with the sightings: it is equally
            // unrecoverable, and restoring history without it re-floods both
            // lists with the user's own gear.
            const payload = {
                version: SIGHT_BACKUP_VERSION,
                exportedAt: new Date().toISOString(),
                sightStore: sightStore,
                shadowWhitelist: [...shadowWhitelist]
            };
            const el = document.createElement('a');
            el.setAttribute('href', 'data:application/json;charset=utf-8,' +
                            encodeURIComponent(JSON.stringify(payload)));
            el.setAttribute('download', 'signalsweep_backup_' +
                            new Date().toISOString().replace(/[:.]/g, '-') + '.json');
            el.style.display = 'none';
            document.body.appendChild(el);
            el.click();
            document.body.removeChild(el);
            showToast('Backed up ' + Object.keys(sightStore).length + ' devices', '✓');
        }

        function importSightStore() {
            const input = document.getElementById('sight-import-file');
            if (!input) return;
            input.value = '';       // so re-picking the same file still fires change
            input.click();
        }

        function onSightImportFile(input) {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                let res;
                try {
                    res = sightMergeBackup(sightStore, shadowWhitelist, JSON.parse(reader.result));
                } catch (e) {
                    console.error('sightStore import failed', e);
                    showToast('Not a valid SignalSweep backup', '✕');
                    return;
                }
                shadowWhitelistSave();
                sightWrite();       // straight to disk, not the 10 s throttle
                showToast('Restored ' + res.added + ' new, merged ' + res.merged, '✓');
                if (currentActiveMode === 4) shadowRenderList();
                else if (currentActiveMode === 2) watchersRenderList();
            };
            reader.readAsText(file);
        }
        window.exportSightStore = exportSightStore;
        window.importSightStore = importSightStore;
        window.onSightImportFile = onSightImportFile;

        // The 16-bit slice of a UUID in any form: '1802', '00001802-0000-...'.
        function short16(uuid) {
            if (!uuid) return '';
            const u = String(uuid).toLowerCase();
            return u.length >= 36 ? u.slice(4, 8) : u.replace(/^0+/, '').padStart(4, '0');
        }

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
                                    // NimBLE reports UUIDs in their full 128-bit
                                    // form, so comparing against the bare 16-bit
                                    // shorthand never matched and this button
                                    // never appeared. Compare on the 16-bit slice.
                                    if (short16(srv.uuid) === '1802' && short16(ch.uuid) === '2a06') {
                                        html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                                    <div><span style="color: var(--text-muted);">└─</span> ${esc(chName)} <span style="color: var(--text-muted); font-size: 0.65rem;">(${esc(ch.uuid)})</span></div>
                                                    <button onclick="triggerBleWrite('${esc(data.mac)}', '${esc(srv.uuid)}', '${esc(ch.uuid)}', '02')" style="background: rgba(0, 242, 254, 0.15); border: 1px solid var(--accent-cyan); color: var(--accent-cyan); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; font-weight: bold;">🔔 RING / FIND</button>
                                                 </div>`;
                                    } else {
                                        html += `<div><span style="color: var(--text-muted);">└─</span> ${esc(chName)} <span style="color: var(--text-muted); font-size: 0.65rem;">(${esc(ch.uuid)})</span></div>`;
                                        if (ch.value_hex) {
                                            html += `<div style="margin-left: 20px; margin-top: 2px;">`;
                                            html += `<span style="color: var(--accent-amber);">HEX:</span> ${esc(ch.value_hex)}<br>`;
                                            html += `<span style="color: var(--accent-cyan);">TXT:</span> ${esc(ch.value_ascii)}`;
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
                        // Bandit's BLE sightings feed the shared store too, so a
                        // tracker's location history survives a mode switch.
                        sightIngest(data.targets, 'BLE');
                        renderTargets(1, data.targets);
                    }
                    // Clear Target is the only way out when the locked device
                    // stops advertising and drops off the list.
                    const btnClear = document.getElementById('btn-clear-lock');
                    if (btnClear) btnClear.style.display = data.locked_mac ? 'block' : 'none';
                } else if (data.mode === 2) {
                    // War Flocking: the firmware now harvests everything it hears
                    // and the phone decides what is bolted down. Signature
                    // confidence arrives as an annotation, not a filter.
                    if (data.targets) renderWatchers(data.targets);
                } else if (data.mode === 3) {
                    // Sky Sweeper: render the drone list (radar blips handled in
                    // renderTargets). Deliberately NOT fed into the sighting
                    // store — aircraft are neither fixed nor tailing you, and
                    // their rotating MACs would just be noise in it.
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
    
        // Export confirmed fixed installations as OSM XML, one node per device
        // at ITS OWN cluster centroid.
        //
        // The previous version never ran: it read a `trackedTargets` variable
        // that does not exist in the app, so every click threw a ReferenceError.
        // It also stamped every node with the phone's last position and labelled
        // everything a Flock ALPR. Publishing a wrong vendor claim against a
        // real coordinate to a shared map is worse than publishing nothing, so
        // this only emits devices the geospatial test confirmed, and only adds a
        // vendor tag when a signature actually matched at Confirmed level.
        function xmlAttr(v) {
            return String(v == null ? '' : v)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        }

        function collectFixedDevices() {
            return Object.entries(sightStore)
                .filter(([mac, rec]) => !shadowWhitelist.has(mac) && classify(rec) === 'fixed')
                .map(([mac, rec]) => ({ mac, rec, cluster: rec.clusters[0] }));
        }

        function exportOSM() {
            const fixed = collectFixedDevices();
            if (fixed.length === 0) {
                showToast('No confirmed fixed installations yet.', '✕');
                return;
            }

            let osm = '<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="SignalSweep">\n';
            let idCounter = -1;   // negative IDs mark not-yet-uploaded elements

            fixed.forEach(({ mac, rec, cluster }) => {
                osm += '  <node id="' + idCounter + '" lat="' + cluster.lat.toFixed(7) +
                       '" lon="' + cluster.lng.toFixed(7) + '">\n';
                // Always true of anything that got here: a radio fixed in place.
                osm += '    <tag k="man_made" v="surveillance"/>\n';
                // Only a Confirmed signature match earns a vendor/type claim.
                if (rec.conf >= 75 && rec.rule) {
                    osm += '    <tag k="surveillance:type" v="ALPR"/>\n';
                    // The vendor category ("Flock Safety"), not the rule name.
                    if (rec.cat) osm += '    <tag k="manufacturer" v="' + xmlAttr(rec.cat) + '"/>\n';
                    osm += '    <tag k="signalsweep:rule" v="' + xmlAttr(rec.rule) + '"/>\n';
                }
                if (rec.name) osm += '    <tag k="name" v="' + xmlAttr(rec.name) + '"/>\n';
                osm += '    <tag k="mac" v="' + xmlAttr(mac) + '"/>\n';
                osm += '    <tag k="source" v="SignalSweep; ' + cluster.visits + ' visits, ' +
                       rec.count + ' sightings"/>\n';
                osm += '  </node>\n';
                idCounter--;
            });

            osm += '</osm>';

            const element = document.createElement('a');
            element.setAttribute('href', 'data:text/xml;charset=utf-8,' + encodeURIComponent(osm));
            element.setAttribute('download', 'signalsweep_fixed_' + new Date().getTime() + '.osm');
            element.style.display = 'none';
            document.body.appendChild(element);
            element.click();
            document.body.removeChild(element);
            showToast('Exported ' + fixed.length + ' confirmed installation(s).', '✓');
        }

        // ---- DeFlock / OSM ground truth -----------------------------------
        // OpenStreetMap already carries crowd-mapped ALPRs (`man_made=surveillance`
        // + `surveillance:type=ALPR`) — the dataset DeFlock renders. Overlaying it
        // gives the geospatial classifier the one thing it otherwise lacks: an
        // independent check. Three outcomes, and the interesting one is the third:
        //   corroborated — you confirmed a radio where OSM says a camera stands.
        //   mapped only  — OSM knows it, you never heard it (wrong side of the
        //                  street, no RF, or it is not a radio at all).
        //   UNMAPPED     — you confirmed a fixed installation nobody has mapped.
        //                  That is the whole point of detecting by geography.
        //
        // This never runs on its own. Querying Overpass tells a third party which
        // patch of the world you are looking at, which for THIS tool's users is a
        // real disclosure — so it is a button, never a map-pan handler, and results
        // are cached so a field trip can run off a prefetch made at home.
        const OVERPASS_ENDPOINTS = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.private.coffee/api/interpreter'
        ];
        const ALPR_CACHE_KEY = 'alprNodes';
        const ALPR_MATCH_M   = 100;   // how close a detection sits to count as the same install

        let alprNodes = [];
        let alprLayer = null;
        try {
            const cached = JSON.parse(localStorage.getItem(ALPR_CACHE_KEY) || '[]');
            if (Array.isArray(cached)) alprNodes = cached;
        } catch (e) {}

        function overpassQuery(b) {
            const box = '(' + b.south.toFixed(5) + ',' + b.west.toFixed(5) + ',' +
                              b.north.toFixed(5) + ',' + b.east.toFixed(5) + ')';
            const base = 'node["man_made"="surveillance"]["surveillance:type"=';
            // OSM tag values are not case-normalised; both spellings are in use.
            return '[out:json][timeout:60];(' +
                   base + '"ALPR"]' + box + ';' +
                   base + '"alpr"]' + box + ';);out body;';
        }

        // Anything here is third-party text from a public wiki-style database.
        // It reaches a popup, so it gets the same treatment as a device name.
        function alprFromElement(e) {
            if (!e || typeof e.lat !== 'number' || typeof e.lon !== 'number') return null;
            const tags = e.tags || {};
            const tag = k => (typeof tags[k] === 'string' && tags[k].trim()) ? tags[k].trim() : '';
            return {
                id: e.id,
                lat: e.lat,
                lng: e.lon,
                operator: tag('operator'),
                manufacturer: tag('manufacturer'),
                direction: tag('camera:direction') || tag('direction')
            };
        }

        async function fetchAlprNodes() {
            if (!map) { showToast('Map not ready', '✕'); return; }
            const b = map.getBounds();
            const bounds = { south: b.getSouth(), west: b.getWest(),
                             north: b.getNorth(), east: b.getEast() };
            const body = 'data=' + encodeURIComponent(overpassQuery(bounds));
            showToast('Querying OpenStreetMap...', '⏳');

            let elements = null, lastErr = '';
            for (const url of OVERPASS_ENDPOINTS) {
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body
                    });
                    if (resp.status === 429) { lastErr = 'rate limited'; continue; }
                    if (!resp.ok) { lastErr = 'HTTP ' + resp.status; continue; }
                    const data = await resp.json();
                    if (Array.isArray(data.elements)) { elements = data.elements; break; }
                    lastErr = 'no element list';
                } catch (e) {
                    lastErr = (e && e.message) || 'unreachable';
                }
            }
            if (!elements) {
                // Offline is the expected case in the field, not an error state:
                // fall back to whatever the last prefetch left behind.
                showToast('Overpass ' + lastErr + (alprNodes.length ? ' - using cache' : ''), '✕');
                if (alprNodes.length) renderAlprLayer();
                return;
            }

            // Merge by node id so panning around builds an area up instead of
            // replacing it - the same reason the sight store merges on import.
            const byId = {};
            alprNodes.forEach(n => { byId[n.id] = n; });
            let fresh = 0;
            elements.forEach(e => {
                const n = alprFromElement(e);
                if (!n) return;
                if (!(n.id in byId)) fresh++;
                byId[n.id] = n;
            });
            alprNodes = Object.values(byId);
            try { localStorage.setItem(ALPR_CACHE_KEY, JSON.stringify(alprNodes)); } catch (e) {}
            renderAlprLayer();
            showToast(fresh + ' new mapped ALPR(s), ' + alprNodes.length + ' cached', '✓');
        }

        // Pair confirmed detections against mapped nodes. Corroboration is a
        // LABEL, never an input to classify() - exactly as signature matches are.
        // Letting OSM promote or demote a detection would re-introduce the
        // list-shaped blindness the geospatial test exists to avoid.
        function alprCorroborate() {
            const fixed = collectFixedDevices();
            const usedNodes = new Set();
            const paired = fixed.map(f => {
                let best = null, bestD = Infinity;
                alprNodes.forEach(n => {
                    const d = haversineM(f.cluster, n);
                    if (d <= ALPR_MATCH_M && d < bestD) { best = n; bestD = d; }
                });
                if (best) usedNodes.add(best.id);
                return { mac: f.mac, rec: f.rec, cluster: f.cluster,
                         node: best, dist: best ? bestD : null };
            });
            return { paired,
                     unmapped: paired.filter(p => !p.node),
                     mappedOnly: alprNodes.filter(n => !usedNodes.has(n.id)) };
        }

        function renderAlprLayer() {
            if (!map || !window.L) return;
            if (alprLayer) map.removeLayer(alprLayer);
            alprLayer = window.L.layerGroup().addTo(map);

            const { paired, unmapped, mappedOnly } = alprCorroborate();

            mappedOnly.forEach(n => {
                window.L.circleMarker([n.lat, n.lng], {
                    radius: 5, color: '#9ca3af', weight: 1, fillOpacity: 0.35
                }).bindPopup('<b>Mapped ALPR</b><br>' +
                    esc(n.operator || n.manufacturer || 'unknown operator') +
                    '<br><span style="color:#9ca3af">not heard by you</span>' +
                    '<br><a href="https://www.openstreetmap.org/node/' +
                    encodeURIComponent(n.id) +
                    '" target="_blank" rel="noopener noreferrer">OSM node</a>'
                ).addTo(alprLayer);
            });

            paired.forEach(p => {
                const hit = !!p.node;
                window.L.circleMarker([p.cluster.lat, p.cluster.lng], {
                    radius: 8,
                    color: hit ? '#34d399' : '#f472b6',
                    weight: 2,
                    fillOpacity: 0.6
                }).bindPopup(
                    '<b>' + (hit ? 'Corroborated' : 'UNMAPPED - not in OSM') + '</b><br>' +
                    esc(p.mac) + (p.rec.name ? '<br>' + esc(p.rec.name) : '') +
                    '<br>' + esc(p.cluster.visits) + ' visits, ' + esc(p.rec.count) + ' sightings' +
                    (hit ? '<br>' + Math.round(p.dist) + ' m from ' +
                           esc(p.node.operator || p.node.manufacturer || 'a mapped ALPR')
                         : '<br><span style="color:#f472b6">nobody has mapped this one</span>')
                ).addTo(alprLayer);
            });

            showToast(unmapped.length + ' unmapped, ' +
                      (paired.length - unmapped.length) + ' corroborated, ' +
                      mappedOnly.length + ' mapped-only', '✓');
        }
        window.fetchAlprNodes = fetchAlprNodes;
        window.renderAlprLayer = renderAlprLayer;

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
                await subscribeNative(device.deviceId);

                updateConnectionUI(true, 'BLE');
                // (No status request: the firmware has no "get" command — the
                // current mode arrives on its next periodic push.)
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
                        try { await subscribeNative(device.deviceId); } catch (e) { /* already subscribed */ }
                        updateConnectionUI(true, 'BLE');
                        // (No status request: the firmware has no "get" command — the
                // current mode arrives on its next periodic push.)
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
                // (No status request: the firmware has no "get" command — the
                // current mode arrives on its next periodic push.)

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
                // (No status request: the firmware has no "get" command — the
                // current mode arrives on its next periodic push.)

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

        // Send Command to ESP32 over BLE or Serial
        async function sendCommand(cmdObj) {
            // ponytail: {raw:'CMD:...'} goes out as the bare string — the firmware's
            // CMD: handlers live in its raw-text fallback, past the JSON parser.
            const jsonStr = (cmdObj.raw || JSON.stringify(cmdObj)) + '\n';
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

        // Remote ID broadcasts the OPERATOR's position, not just the aircraft's.
        // That is the single most useful field in the whole standard for this
        // project, and it used to arrive on the wire and be thrown away. Drone
        // and pilot both get a marker, joined by a line so it is obvious which
        // operator is flying which aircraft.
        let droneMarkers = {};

        function updateDroneMarkers(targets) {
            if (!map || !window.L) return;
            const seen = {};
            (targets || []).forEach(t => {
                const key = t.uas_id || t.basic_id || t.mac;
                if (!key) return;
                const dLat = (t.latitude != null) ? t.latitude : t.drone_lat;
                const dLng = (t.longitude != null) ? t.longitude : t.drone_long;
                const oLat = (t.operator_latitude != null) ? t.operator_latitude : t.pilot_lat;
                const oLng = (t.operator_longitude != null) ? t.operator_longitude : t.pilot_long;
                const hasDrone = dLat != null && dLng != null && (dLat !== 0 || dLng !== 0);
                const hasPilot = oLat != null && oLng != null && (oLat !== 0 || oLng !== 0);
                if (!hasDrone && !hasPilot) return;

                seen[key] = true;
                let m = droneMarkers[key];
                if (!m) {
                    m = droneMarkers[key] = {
                        drone: window.L.circleMarker([0, 0], { radius: 6, color: '#00f2fe', fillOpacity: 0.9 }),
                        pilot: window.L.circleMarker([0, 0], { radius: 7, color: '#ff4d4d', fillOpacity: 0.9 }),
                        link: window.L.polyline([], { color: '#ff4d4d', weight: 1, dashArray: '4 4' })
                    };
                }
                if (hasDrone) {
                    m.drone.setLatLng([dLat, dLng]).addTo(map)
                        .bindPopup('Drone ' + esc(key) + '<br>' + Number(dLat).toFixed(5) + ', ' + Number(dLng).toFixed(5));
                } else if (map.hasLayer(m.drone)) { map.removeLayer(m.drone); }

                if (hasPilot) {
                    m.pilot.setLatLng([oLat, oLng]).addTo(map)
                        .bindPopup('PILOT of ' + esc(key) + '<br>' + Number(oLat).toFixed(5) + ', ' + Number(oLng).toFixed(5) +
                                   (t.operator_id ? '<br>ID: ' + esc(t.operator_id) : ''));
                } else if (map.hasLayer(m.pilot)) { map.removeLayer(m.pilot); }

                if (hasDrone && hasPilot) {
                    m.link.setLatLngs([[dLat, dLng], [oLat, oLng]]).addTo(map);
                } else if (map.hasLayer(m.link)) { map.removeLayer(m.link); }
            });

            // Drop markers for drones that have aged out of the target list.
            Object.keys(droneMarkers).forEach(k => {
                if (seen[k]) return;
                const m = droneMarkers[k];
                [m.drone, m.pilot, m.link].forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
                delete droneMarkers[k];
            });
        }

        // ponytail: rebuilds every row each push (`list.innerHTML = html`). Same
        // ceiling and same keyed-rendering upgrade path as the classifier
        // renderers — see the note above sightRowOpen() for the tripwire and the
        // step-by-step. Mode 1 and 3 lists are short today, so this bites later
        // than Watcher's Watch will.
        function renderTargets(mode, targets) {
            detectedDevices = targets || [];
            if (mode === 3) updateDroneMarkers(targets);

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
                // Everything below is chosen by the observed device, so it is
                // escaped before it reaches innerHTML.
                const nameHtml = esc(name);
                const macHtml = esc(mac);
                let rssi = t.rssi || -99;
                let isLocked = t.is_locked ? 'locked' : '';

                let details = '';
                if (mode === 1) {
                    details = `Type: ${esc(t.type || 'Generic BLE')} | Count: ${esc(t.count || 1)}`;
                } else if (mode === 3) {
                    // The pilot's own coordinates are the point of Remote ID —
                    // show them, and drop a marker (see updatePilotMarkers).
                    const opLat = (t.operator_latitude != null) ? t.operator_latitude : t.pilot_lat;
                    const opLng = (t.operator_longitude != null) ? t.operator_longitude : t.pilot_long;
                    const hasOp = opLat != null && opLng != null && (opLat !== 0 || opLng !== 0);
                    const pilotPos = hasOp ? ` @ ${Number(opLat).toFixed(5)}, ${Number(opLng).toFixed(5)}` : '';
                    details = `Speed: ${esc(t.speed || 0)}m/s | Alt: ${esc(t.altitude != null ? t.altitude : (t.drone_altitude || 0))}m | Pilot: ${esc(t.operator_id || 'Unknown')}${pilotPos} | Src: ${esc(t.source || 'BLE')}`;
                    
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
                    details = `Type: ${esc(t.type || 'Unclassified')} | Count: ${esc(t.count || 1)}`;
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
                    badgeHtml = `<span style="margin-left:8px; font-size:0.65rem; font-weight:bold; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid ${color}; color:${color};">${esc(tier)} ${esc(conf)}%</span>`;
                } else if (mode === 1 && (t.is_separated || (t.stalking_score || 0) >= 40)) {
                    const sep = t.is_separated ? ' · separated' : '';
                    badgeHtml = `<span style="margin-left:8px; font-size:0.65rem; font-weight:bold; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid var(--accent-red); color:var(--accent-red);">⚠ Stalking ${esc(t.stalking_score || 0)}${sep}</span>`;
                }

                html += `
                <div class="target-card ${mode === 1 ? isLocked : ''}${mode === 1 ? ' js-lock-row' : ''}" ${mode === 1 ? `data-mac="${macHtml}" data-locked="${t.is_locked ? '1' : '0'}"` : ''}>
                    <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                        <div>
                            <h3 style="color: var(--accent-cyan); margin-bottom: 0.3rem; font-size: 1.1rem;">${nameHtml}${badgeHtml}</h3>
                            <div style="font-size: 0.8rem; color: var(--text-muted)">MAC: ${macHtml} | ${details}</div>
                        </div>
                        ${rssiSectionHtml}
                    </div>
                    ${gattHtml}
                </div>`;
            });
            list.innerHTML = html;
        }

        // ---- Rendering the two branches of the classifier -----------------
        // Both lists are built from the same sightStore; they differ only in
        // which side of classify() they show.
        //
        // ponytail: every list here rebuilds with `list.innerHTML = html` once
        // per telemetry push. Known ceiling: full teardown/rebuild of every row
        // at 1 Hz. That was free when Watcher's Watch was gated and showed 0-3
        // rows; it now harvests everything and can show up to WATCHERS_MAX_REPORT
        // (40). Nothing is measured to be wrong yet — deliberately left simple
        // until it actually bites.
        //
        // TRIPWIRE — switch to the upgrade below if any of these show up:
        //   - the list visibly flickers, or scroll position jumps while reading
        //   - a row cannot be tapped reliably because it is replaced mid-tap
        //   - profiling shows the 1 Hz render dominating the main thread
        //   - you want per-row state that must survive a frame (expanded
        //     detail, a sparkline, an inline edit) — that is the hard blocker,
        //     since a full rebuild destroys it by construction
        //
        // UPGRADE PATH — keyed incremental rendering, ~100 lines, no framework:
        //  1. Give each renderer a persistent `Map<mac, HTMLElement>` beside it
        //     (rowCache), and build rows as real elements once instead of as a
        //     concatenated string. Reuse `sightRowOpen`'s data-mac contract so
        //     the existing delegated click listeners keep working untouched.
        //  2. Per frame: diff the desired mac set against rowCache. Create only
        //     new macs, remove only departed ones, and for survivors write just
        //     the fields that changed (rssi, visits, hits, badge) via
        //     textContent on cached child refs — never innerHTML.
        //  3. Reorder with a single pass of `list.appendChild(existingEl)` in
        //     the sorted order; appendChild on an attached node moves it, so
        //     ordering costs no re-creation and preserves focus and scroll.
        //  4. Clear rowCache wherever the list is currently blown away by hand
        //     (updateActiveUI's "Switching modes..." placeholder, mode switch).
        //
        // Doing this also removes the string-concatenation-plus-esc() pattern
        // from these paths, which makes the escaping structural rather than
        // dependent on remembering to call esc() at every new interpolation.
        // renderTargets() (modes 1 and 3) has the same ceiling and the same fix.

        // Shared row chrome. `mac` goes into a data attribute, never into an
        // onclick string, so a device cannot inject script through its address.
        function sightRowOpen(mac, color) {
            return '<div class="target-card js-sight-row" data-mac="' + esc(mac) +
                   '" style="border-color:' + color + '; cursor:pointer;">';
        }

        function whitelistBar() {
            if (shadowWhitelist.size === 0) return '';
            return '<div style="text-align:center; padding:8px; margin-bottom:10px; font-size:0.75rem; color:var(--text-muted);">' +
                   shadowWhitelist.size + ' device(s) marked yours · ' +
                   '<a onclick="shadowWhitelistClear()" style="color:var(--accent-cyan); cursor:pointer; text-decoration:underline;">Clear</a></div>';
        }

        function noFixNotice(msg) {
            return '<div class="mode-card" style="text-align:center; padding:2rem; color:var(--accent-amber); display:block; border-style:dashed;">' + esc(msg) + '</div>';
        }

        function emptyNotice(msg) {
            return '<div class="mode-card" style="text-align:center; padding:2rem; color:var(--text-muted); display:block; border-style:dashed;">' + esc(msg) + '</div>';
        }

        // Delegated clicks: one listener for every generated row. Replaces the
        // per-row onclick="...('<mac>')" strings, which interpolated a
        // device-supplied value straight into executable code.
        document.addEventListener('click', (ev) => {
            if (!ev.target.closest) return;
            const sightRow = ev.target.closest('.js-sight-row');
            if (sightRow && sightRow.dataset.mac) {
                shadowWhitelistAdd(sightRow.dataset.mac);
                return;
            }
            const lockRow = ev.target.closest('.js-lock-row');
            if (lockRow && lockRow.dataset.mac) {
                lockTarget(lockRow.dataset.mac, lockRow.dataset.locked === '1');
            }
        });

        // ---- Watcher's Watch (mode 2): the "fixed" branch -----------------
        function renderWatchers(targets) {
            sightIngest(targets, 'BLE');
            watchersRenderList();
        }

        // A device pinned to ONE place across repeat visits is bolted to
        // something. That test is vendor-agnostic, so this list finds cameras
        // whose OUI is on no list anywhere; the signature match, when there is
        // one, only labels what was already found geospatially.
        function watchersRenderList() {
            const list = document.getElementById('targets-list');
            if (!list) return;
            const loc = globalPhoneLocation;
            const wl = whitelistBar();

            if (!loc) {
                list.innerHTML = wl + noFixNotice('Waiting for a GPS fix — drive or walk your route and anything bolted to a pole will confirm on the second pass.');
                return;
            }
            if (loc.acc > SIGHT_ACCURACY_MAX_M) {
                list.innerHTML = wl + noFixNotice('GPS accuracy is ' + Math.round(loc.acc) + ' m (need ' + SIGHT_ACCURACY_MAX_M + ' m). Sightings are still being collected but not placed — a vague fix would put a camera on the wrong corner.');
                return;
            }

            const rows = Object.entries(sightStore)
                .filter(([mac]) => !shadowWhitelist.has(mac))
                .map(([mac, rec]) => ({ mac, rec, kind: classify(rec) }));

            const fixed = rows.filter(r => r.kind === 'fixed')
                .sort((a, b) => (b.rec.conf || 0) - (a.rec.conf || 0) ||
                                (b.rec.clusters[0].visits - a.rec.clusters[0].visits));
            const candidates = rows.filter(r => r.kind === 'candidate').length;

            if (fixed.length === 0) {
                list.innerHTML = wl + emptyNotice('Tracking ' + rows.length + ' device(s), ' + candidates +
                    ' seen at one place so far. A device confirms as fixed infrastructure once you have passed it on ' +
                    SIGHT_FIXED_VISITS + ' separate visits.');
                return;
            }

            let html = wl;
            fixed.forEach(({ mac, rec }) => {
                const c = rec.clusters[0];
                // Only a Confirmed signature match earns a vendor claim. The
                // geospatial test says "this is infrastructure", not "this is a
                // Flock camera" — and the wrong vendor name on a real location
                // is worse than no name.
                const named = (rec.conf >= 75 && rec.rule);
                const color = named ? 'var(--accent-red)' : 'var(--accent-amber)';
                const label = rec.name || (named ? rec.rule : 'Fixed installation');
                const vendor = named ? '<span style="margin-left:8px; font-size:0.65rem; font-weight:bold; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid ' + color + '; color:' + color + ';">' + esc(rec.tier || 'Confirmed') + '</span>' : '';
                html += sightRowOpen(mac, color) +
                    '<div style="display:flex; justify-content:space-between; width:100%; align-items:center;">' +
                        '<div>' +
                            '<h3 style="color:var(--accent-cyan); margin-bottom:0.3rem; font-size:1.1rem;">' + esc(label) + vendor + '</h3>' +
                            '<div style="font-size:0.8rem; color:var(--text-muted)">MAC: ' + esc(mac) + ' | ' + esc(rec.proto || 'BLE') +
                                ' | ' + c.visits + ' visits | ' + rec.count + ' hits' +
                                (rec.rule ? ' | ' + esc(rec.rule) + ' (' + (rec.conf || 0) + ')' : ' | no signature match') + '</div>' +
                            '<div style="font-size:0.7rem; color:var(--text-muted); margin-top:0.2rem;">' +
                                c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) + ' · tap if this is yours → hide it</div>' +
                        '</div>' +
                        '<div style="text-align:right;">' +
                            '<div style="font-size:1.25rem; font-weight:bold; color:' + color + '">' + c.visits + '📍</div>' +
                            '<div style="font-size:0.7rem; color:var(--text-muted)">' + esc(rec.rssi) + ' dBm</div>' +
                        '</div>' +
                    '</div></div>';
            });
            list.innerHTML = html;
        }

        // ---- Shadow (mode 4): the "mobile" branch -------------------------
        function renderShadow(sightings) {
            sightIngest(sightings, 'BLE');
            shadowRenderList();
        }

        // Ranked by how many distinct places each device has shadowed you.
        function shadowRenderList() {
            const now = Date.now();
            const loc = globalPhoneLocation;
            const list = document.getElementById('targets-list');
            if (!list) return;
            const wl = whitelistBar();

            if (!loc) {
                list.innerHTML = wl + noFixNotice('Waiting for GPS fix — move around and Shadow will flag anything that follows you.');
                return;
            }

            const rows = Object.entries(sightStore)
                .filter(([mac]) => !shadowWhitelist.has(mac))
                .map(([mac, rec]) => ({ mac, rec, score: shadowScore(rec, now) }))
                .sort((a, b) => b.score - a.score);

            const tails = rows.filter(r => r.score > 0);
            if (tails.length === 0) {
                list.innerHTML = wl + emptyNotice('Tracking ' + rows.length + ' device(s) across your route… none seen in 2+ separate places yet.');
                return;
            }

            let html = wl;
            tails.forEach(({ mac, rec, score }) => {
                const alert = rec.clusters.length >= SIGHT_ALERT_CLUSTERS;
                const color = alert ? 'var(--accent-red)' : 'var(--accent-amber)';
                const label = rec.name || (rec.proto === 'WiFi' ? 'Wi-Fi device' : 'BLE device');
                html += sightRowOpen(mac, color) +
                    '<div style="display:flex; justify-content:space-between; width:100%; align-items:center;">' +
                        '<div>' +
                            '<h3 style="color:var(--accent-cyan); margin-bottom:0.3rem; font-size:1.1rem;">' + esc(label) +
                                '<span style="margin-left:8px; font-size:0.65rem; font-weight:bold; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid ' + color + '; color:' + color + ';">' +
                                (alert ? '⚠ Following you' : 'Watching') + ' ' + score + '</span></h3>' +
                            '<div style="font-size:0.8rem; color:var(--text-muted)">MAC: ' + esc(mac) + ' | ' + esc(rec.proto) +
                                ' | seen in ' + rec.clusters.length + ' places | ' + rec.count + ' hits</div>' +
                            '<div style="font-size:0.7rem; color:var(--accent-cyan); margin-top:0.2rem;">tap if this is yours → hide it</div>' +
                        '</div>' +
                        '<div style="text-align:right;">' +
                            '<div style="font-size:1.25rem; font-weight:bold; color:' + color + '">' + rec.clusters.length + '📍</div>' +
                            '<div style="font-size:0.7rem; color:var(--text-muted)">' + esc(rec.rssi) + ' dBm</div>' +
                        '</div>' +
                    '</div></div>';
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
                // The map is shared by War Flocking (your trail + confirmed
                // installations) and Sky Sweeper (drone + pilot markers).
                document.getElementById('war-flocking-ui').style.display = (modeInt === 2 || modeInt === 3) ? 'flex' : 'none';
                // The .osm export only means anything for fixed installations.
                const btnOsm = document.getElementById('btn-export-osm');
                if (btnOsm) btnOsm.style.display = (modeInt === 2) ? 'flex' : 'none';
                // The OSM cross-check is about fixed installations, so it rides
                // with the .osm export and stays off Sky Sweeper's shared map.
                const alprRow = document.getElementById('alpr-row');
                if (alprRow) alprRow.style.display = (modeInt === 2) ? 'flex' : 'none';
                if (modeInt !== 2 && map && alprLayer) { map.removeLayer(alprLayer); alprLayer = null; }
                if (modeInt === 2) {
                    initGPS();
                    if (!map) setTimeout(initMap, 100);
                    // Redraw from the cache so a prefetched area is on screen
                    // without another network call.
                    if (alprNodes.length) setTimeout(renderAlprLayer, 300);
                }

                // Show/hide sky sweeper radar depending on mode
                document.getElementById('sky-sweeper-ui').style.display = (modeInt === 3) ? 'flex' : 'none';
                if (modeInt === 3) {
                    initGPS();
                    // Sky Sweeper gets the map too: Remote ID broadcasts the
                    // OPERATOR's position, and a pilot standing somewhere real
                    // belongs on a map, not on a radar sweep.
                    if (!map) setTimeout(initMap, 100);
                }

                // Shadow needs the phone's location to cluster sightings.
                // The sighting store is deliberately NOT reset on mode entry:
                // confirming a tail (or a fixed camera) takes repeat visits over
                // days, and wiping it here made that impossible.
                if (modeInt === 4) {
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
            // Restore the sighting history before anything renders: confirming a
            // fixed installation depends on visits recorded on previous runs.
            sightStoreLoad();
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
