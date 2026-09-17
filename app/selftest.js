// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

// ponytail: the smallest thing that makes `node` able to run app.js's own
// self-check. app.js is a classic browser script; stub just enough of the DOM
// for its top-level lines, then call the check it exposes on window.
//   node app/selftest.js   -> exit 0 if category routing + pin crypto are sane
const noop = () => {};
const store = new Map();
global.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
};
global.document = {
    addEventListener: noop,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute: noop, style: {}, click: noop, classList: { add: noop, remove: noop } }),
    body: { appendChild: noop, removeChild: noop }
};
global.window = global;

await import('./public/app.js');

// ---------------------------------------------------------------------------
// Markup/selector drift check.
//
// The band tabs were dead for a release because the delegated click listener
// still matched '#lens-row .lens-tab' after the markup was rebuilt as
// '#bands .band'. Nothing threw, nothing logged, the tabs just did nothing.
// Any selector app.js anchors to an id has to exist in index.html.
import { readFileSync } from 'node:fs';
const appSrc = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const htmlIds = new Set([...htmlSrc.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const missing = [];

// getElementById targets, minus ids the app creates at runtime.
const RUNTIME_IDS = new Set([]);
for (const m of appSrc.matchAll(/getElementById\('([^']+)'\)/g)) {
    const id = m[1];
    if (id.includes("' +")) continue;               // built dynamically
    if (RUNTIME_IDS.has(id) || htmlIds.has(id)) continue;
    missing.push('getElementById(' + id + ')');
}
// Any id-anchored selector passed to closest()/querySelector().
for (const m of appSrc.matchAll(/(?:closest|querySelector(?:All)?)\('(#[^']+)'\)/g)) {
    const id = m[1].slice(1).split(/[\s.\[>]/)[0];
    if (!htmlIds.has(id)) missing.push(m[1]);
}

if (missing.length) {
    console.log('[signalsweep self-test] selectors with no matching markup:', missing);
    console.log('FAIL: selector/markup drift');
    process.exit(1);
}
console.log('[signalsweep self-test] selectors resolve against index.html: ok');

// The beep mask is a bitmask shared with the firmware: app.js's BEEP_BITS must
// agree with the AlertCategory enum order in hardware_manager.h, or unticking
// "Tracker" mutes body cams instead. Nothing at runtime would tell you.
const fwEnum = readFileSync(new URL('../firmware/src/hardware_manager.h', import.meta.url), 'utf8')
    .match(/enum AlertCategory \{([^}]*)\}/)[1]
    .split(/\r?\n/).map(l => (l.match(/\bALERT_([A-Z]+)/) || [])[1]).filter(Boolean);
const appBits = [...appSrc.match(/const BEEP_BITS = \{([^}]*)\}/)[1]
    .matchAll(/(\w+):\s*(\d+)/g)].map(m => [m[1], Number(m[2])]);
const bitDrift = [];
appBits.forEach(([key, bit], i) => {
    if (fwEnum[i] !== key.toUpperCase()) bitDrift.push(key + ' vs ALERT_' + fwEnum[i]);
    if (bit !== (1 << i)) bitDrift.push(key + '=' + bit + ' expected ' + (1 << i));
    if (!htmlIds.has('beep-' + key)) bitDrift.push('no #beep-' + key + ' control');
});
// And those controls must not be checkboxes. A checkbox owns its own checked
// state and flips the instant it is tapped, before the BLE write is attempted
// and regardless of whether it succeeds -- so a rejected or dropped write left
// the box showing a mask the device never received, silently, for the rest of
// the session. The sound rows are buttons painted only from the device's own
// report; this is the regression that change turns on, so it is asserted.
for (const m of htmlSrc.matchAll(/<input [^>]*>/g)) {
    if (/id="beep-/.test(m[0]) && /type="checkbox"/.test(m[0]))
        bitDrift.push('#' + (m[0].match(/id="([^"]+)"/) || [])[1] + ' is a checkbox again');
}
if (appBits.length !== fwEnum.length) bitDrift.push('count ' + appBits.length + ' vs ' + fwEnum.length);
if (bitDrift.length) {
    console.log('FAIL: beep mask drift:', bitDrift);
    process.exit(1);
}
console.log('[signalsweep self-test] beep mask bits match firmware AlertCategory: ok');

// Every field the firmware reports in CMD:CFG has to be read by the app, or it
// is state the device owns and the phone silently guesses at. `buzzer` was
// exactly that: reported by neither side, so the app shipped a hardcoded
// "Buzzer: ON" against boards that were muted.
const cfgKeys = [...readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8')
    .match(/String getBleConfigJson\(\) \{[\s\S]*?\n\}/)[0]
    .matchAll(/doc\["(\w+)"\]\s*=/g)].map(m => m[1]);
// Deliberately unread: `cfg` is the discriminator itself.
const cfgIgnored = new Set(['cfg']);
const cfgUnread = cfgKeys.filter(k => !cfgIgnored.has(k) &&
    !appSrc.includes('cfg.' + k) && !appSrc.includes('data.' + k));
if (cfgKeys.length < 5 || cfgUnread.length) {
    console.log('FAIL: CMD:CFG fields the app never reads:', cfgUnread,
                '(parsed', cfgKeys.length, 'keys)');
    process.exit(1);
}
console.log('[signalsweep self-test] app reads every CMD:CFG field: ok');

// C5 port: the bench-measured radio settings must stay behind the C5 guard, and
// the S3 path must keep its own values (the S3 build is byte-identical by contract).
{
    const wsrc = readFileSync(new URL('../firmware/src/mode_watchers_watch.cpp', import.meta.url), 'utf8');
    const c5 = [...wsrc.matchAll(/#if CONFIG_IDF_TARGET_ESP32C5\r?\n([\s\S]*?)(?=#else|#endif)/g)].map(m => m[1]).join('\n');
    const fail = [];
    let hop = '';
    try { hop = readFileSync(new URL('../firmware/src/c5_radio.h', import.meta.url), 'utf8'); }
    catch (e) { fail.push('firmware/src/c5_radio.h is missing'); }
    if (!/rx_state\s*!=\s*0/.test(c5)) fail.push('C5 promiscuous callback does not drop rx_state != 0');
    if (!/setInterval\(50\)/.test(c5) || !/setWindow\(25\)/.test(c5)) fail.push('C5 BLE scan is not 50/25');
    if (!/c5BuildHop\(/.test(c5)) fail.push('C5 hopper does not use c5BuildHop()');
    if (!/parked\s*<=\s*177\b/.test(c5)) fail.push('C5 hunt parking cannot reach 5 GHz channels');
    if (!/pdMS_TO_TICKS\(C5_HOP_DWELL_MS\)/.test(c5)) fail.push('C5 hopper does not use C5_HOP_DWELL_MS');
    if (!/esp_wifi_set_country_code\(SWEEP_COUNTRY/.test(c5)) fail.push('C5 does not set the country code (5 GHz gate)');
    if (!/esp_wifi_set_band_mode\(WIFI_BAND_MODE_AUTO\)/.test(c5)) fail.push('C5 does not enable dual-band mode');
    if (!/pScan->setWindow\(50\)/.test(wsrc)) fail.push('S3 BLE window 50/100 changed');
    if (hop && !/\{\s*36,\s*40,\s*44,\s*48,\s*149,\s*153,\s*157,\s*161,\s*165\s*\}/.test(hop))
        fail.push('c5_radio.h 5 GHz list is not the measured non-DFS set');
    if (hop && !/C5_HOP_DWELL_MS\s*=\s*120\s*;/.test(hop)) fail.push('C5 dwell is not the measured 120 ms');
    if (fail.length) { console.log('FAIL: C5 radio settings:', fail); process.exit(1); }
}
console.log('[signalsweep self-test] C5 radio settings guarded: ok');

// Band select: the enum order is the wire contract, the device is the authority
// (push + persisted), and the controls are buttons painted from device frames.
{
    const fail = [];
    const radioH = readFileSync(new URL('../firmware/src/c5_radio.h', import.meta.url), 'utf8');
    if (!/BAND_BOTH\s*=\s*0,\s*BAND_24\s*=\s*1,\s*BAND_5\s*=\s*2/.test(radioH)) fail.push('SweepBand order changed');
    const wsrc = readFileSync(new URL('../firmware/src/mode_watchers_watch.cpp', import.meta.url), 'utf8');
    if (!/doc\["band"\]\s*=\s*getBand\(\)/.test(wsrc)) fail.push('the 1 Hz push does not carry band');
    if (!/prefs\.putUChar\("band"/.test(wsrc) || !/prefs\.getUChar\("band"/.test(wsrc)) fail.push('band is not persisted in sweep-st');
    const bsrc = readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8');
    if (!/doc\["band"\]\.is<int>\(\)/.test(bsrc)) fail.push('no {"band":N} command');
    ['0', '1', '2'].forEach(i => { if (!htmlSrc.includes('data-band="' + i + '"')) fail.push('no band button ' + i); });
    if (/<input[^>]*data-band=/.test(htmlSrc)) fail.push('a band control is an <input>');
    if (!appSrc.includes("closest('#band-modes .radio-tab')")) fail.push('band buttons are not wired in the click listener');
    if (!/typeof data\.band === 'number'/.test(appSrc)) fail.push('syncDeviceState ignores the pushed band');
    if (!/setBandUi\(cfg\.band\)/.test(appSrc)) fail.push('applyConfigToSettings ignores cfg.band');
    if (!/setBandUi\(null\)/.test(appSrc)) fail.push('band is not cleared on disconnect');
    if (fail.length) { console.log('FAIL: band select:', fail); process.exit(1); }
}
console.log('[signalsweep self-test] band select contract: ok');

// Themes are an index shared with the firmware: app.js's THEMES order must be
// hardware_manager.h's ThemeId order, or picking "Glacier" lights Party. Like the
// beep mask, nothing at runtime would say so. The theme also has to ride the
// push (the device is the authority) and its chips must not be inputs.
const themeFail = [];
const fwThemes = ((readFileSync(new URL('../firmware/src/hardware_manager.h', import.meta.url), 'utf8')
    .match(/enum ThemeId[^{]*\{([^}]*)\}/) || [])[1] || '')
    .match(/THEME_([A-Z]+)/g) || [];
const appThemes = ((appSrc.match(/const THEMES = \[([^\]]*)\]/) || [])[1] || '').match(/'(\w+)'/g) || [];
if (fwThemes.length !== 5) themeFail.push('firmware ThemeId has ' + fwThemes.length + ' entries');
fwThemes.forEach((t, i) => {
    if (("'" + t.slice(6).toLowerCase() + "'") !== appThemes[i]) themeFail.push(t + ' vs ' + appThemes[i]);
    if (!htmlSrc.includes('data-theme="' + i + '"')) themeFail.push('no chip for theme ' + i);
});
if (!/doc\["theme"\]\s*=\s*getTheme\(\)/.test(readFileSync(new URL('../firmware/src/mode_watchers_watch.cpp', import.meta.url), 'utf8')))
    themeFail.push('the 1 Hz push does not carry theme');
if (/<input[^>]*data-theme=/.test(htmlSrc)) themeFail.push('a theme control is an <input>');
// The theme is applied to the finished frame, like the LED mode, so no draw
// routine may know about it -- otherwise the next animation someone adds
// silently ignores themes. And it must run before the LED-mode block, which
// has to see the recoloured frame.
const hwSrc = readFileSync(new URL('../firmware/src/hardware_manager.cpp', import.meta.url), 'utf8');
for (const f of ['drawAnimation', 'drawHuntMeter']) {
    const body = (hwSrc.match(new RegExp('static void ' + f + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')) || [''])[0];
    if (!body) themeFail.push('cannot find ' + f);
    if (/themeId|THEMES/.test(body)) themeFail.push(f + ' knows about themes');
}
const hwTask = hwSrc.slice(hwSrc.indexOf('static void HardwareManagerTask'));
const iApply = hwTask.indexOf('applyTheme(now)'), iLedOff = hwTask.indexOf('if (ledMode == LED_OFF)');
if (iApply < 0 || iApply > iLedOff) themeFail.push('applyTheme must run on the finished frame, before the LED mode');
// Pitch lives in buzzerTone(), the single door every sound goes through, so
// jingles, the hunt clicker and the siren all follow the theme and no rhythm
// can change. And a new theme must preview itself on the board.
if (!/static inline void buzzerTone\([^)]*\) \{[\s\S]{0,400}?THEMES\[/.test(hwSrc))
    themeFail.push('buzzerTone does not apply the theme pitch');
if (!/void setTheme\([\s\S]{0,1200}?ANIM_BOOT/.test(hwSrc))
    themeFail.push('setTheme does not preview the theme');
// LED One is Classic-only: applyTheme must bail before touching the frame,
// and Party's grey idle fill must not run under One either, or the "One
// keeps Classic colours" rule is only half enforced.
const applyThemeBody = (hwSrc.match(/static void applyTheme\([^)]*\) \{[\s\S]*?\n\}/) || [''])[0];
if (!/LED_ONE/.test(applyThemeBody)) themeFail.push('applyTheme does not return early for LED_ONE');
if (!/static inline void buzzerTone\([^)]*\) \{[\s\S]{0,400}?THEME_CLASSIC/.test(hwSrc))
    themeFail.push('buzzerTone does not skip Classic');
if (!/themeId == THEME_PARTY && ledMode != LED_ONE/.test(hwSrc))
    themeFail.push('Party idle fill is not gated off LED One');
// Flash frames (factory-reset red, siren strobe) are warnings, not ID
// animations -- applyTheme must not recolour them.
if (!/if \(!flashActive\) applyTheme\(now\)/.test(hwSrc))
    themeFail.push('flash frames are recoloured by applyTheme');
if (themeFail.length) { console.log('FAIL: themes:', themeFail); process.exit(1); }
console.log('[signalsweep self-test] theme ids match firmware ThemeId: ok');

// The cable chirp is a two-sided handshake with no reply to fail loudly on: if
// either side renames a command the board just goes quiet. Both strings must
// appear on both sides.
const mainSrc = readFileSync(new URL('../firmware/src/main.cpp', import.meta.url), 'utf8');
for (const c of ["'CMD:HOST'", "'CMD:HOST:BYE'"]) {
    const fw = '"' + c.slice(1, -1) + '"';
    if (!appSrc.includes(c) || !mainSrc.includes(fw)) {
        console.log('FAIL: host handshake', c, 'missing from', appSrc.includes(c) ? 'main.cpp' : 'app.js');
        process.exit(1);
    }
}
console.log('[signalsweep self-test] cable host handshake matches firmware: ok');

// The vendor lists load with a silent catch (a missing name must never take
// the scope down), so this is the only place a list that stopped shipping shows.
for (const [f, min] of [['oui.txt', 20000], ['bt-company.txt', 1000]]) {
    const n = readFileSync(new URL('./public/' + f, import.meta.url), 'utf8').split('\n').filter(Boolean).length;
    if (n < min) { console.log('FAIL: public/' + f + ' has', n, 'entries'); process.exit(1); }
}
console.log('[signalsweep self-test] vendor lists ship: ok');

// The Flock wildcard-probe signature is the only way a current camera reaches
// the buzzer (management AP dead Dec 2025, BLE dead spring 2026). No host C++
// compiler ships here and there is no native test env, so we can't unit-test the
// C directly -- but a JS reimplementation would only prove the copy, not the
// firmware. So assert the invariants against the real source, the same way the
// BEEP_BITS and CMD:CFG checks above do. The emitter (over-the-air, two boards)
// is the runtime half of the proof.
const fw = readFileSync(new URL('../firmware/src/mode_watchers_watch.cpp', import.meta.url), 'utf8');
const flockFail = [];

// Schema must be bumped, or deployed boards keep the stale rule set for ever.
const ver = Number((fw.match(/#define SIG_SCHEMA_VERSION\s+(\d+)/) || [])[1]);
if (!(ver >= 6)) flockFail.push('SIG_SCHEMA_VERSION is ' + ver + ', expected >= 6');

// Default OUI list invariants: the 2026-07-16 sync, and no randomized-MAC prefix.
const flockBlock = (fw.match(/const char\* flockOuis\[\] = \{([\s\S]*?)\};/) || [])[1] || '';
const ouis = [...flockBlock.matchAll(/"([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})"/g)].map(m => m[1].toLowerCase());
if (!ouis.includes('14:b5:cd')) flockFail.push('default OUIs missing 14:b5:cd');
if (ouis.includes('f8:a2:d6')) flockFail.push('default OUIs still ship f8:a2:d6 (Sony false positive)');
for (const o of ouis) {
    // loadWatchersSignatures() rejects these at load; shipping one as a default
    // means it silently never matches. Bit 1 (0x02) of the first octet.
    if (parseInt(o.slice(0, 2), 16) & 0x02) flockFail.push('default OUI ' + o + ' is locally-administered');
}

// The wildcard-probe weights must each be able to trip the alarm alone, and the
// path must be gated on the Flock category (not just any OUI) and on a wildcard
// SSID (not just any probe) -- both gates are what stop it firing on every phone.
const alertMin = Number((fw.match(/#define CONF_ALERT_MIN\s+(\d+)/) || [])[1]);
const wProbe = Number((fw.match(/#define W_WIFI_PROBE\s+(\d+)/) || [])[1]);
const wIeSig = Number((fw.match(/#define W_WIFI_IE_SIG\s+(\d+)/) || [])[1]);
if (!(wProbe >= alertMin)) flockFail.push('W_WIFI_PROBE ' + wProbe + ' < CONF_ALERT_MIN ' + alertMin);
if (!(wIeSig >= alertMin)) flockFail.push('W_WIFI_IE_SIG ' + wIeSig + ' < CONF_ALERT_MIN ' + alertMin);
if (!/if\s*\(flockOui && wildcardSsid\)/.test(fw)) flockFail.push('wildcard-probe scoring is not gated on flockOui && wildcardSsid');
// The 50:6f:9a:16:03:01:03 IE must NEVER alert on its own: consumer WiFi
// modules (AzureWave and others) send it, and standalone it beeped at passers-by.
if (/if\s*\(liteonSig\)\s*\{/.test(fw)) flockFail.push('liteonSig alerts standalone again -- it is a false-positive machine without the Flock OUI + wildcard gate');
if (!/if\s*\(sig\.category == "Flock Safety"\) flockOui = true;/.test(fw)) flockFail.push('flockOui is not set from the Flock Safety category');
// The Lite-On IE fingerprint bytes, in order: 50 6f 9a 16 03 01 03 at elen 7.
if (!/elen == 7[\s\S]{0,200}0x50[\s\S]{0,60}0x6F[\s\S]{0,60}0x9A[\s\S]{0,60}0x16[\s\S]{0,40}0x03[\s\S]{0,40}0x01[\s\S]{0,40}0x03/.test(fw))
    flockFail.push('Lite-On IE-sig bytes (50 6f 9a 16 03 01 03 / elen 7) not found in order');

// BLE Remote ID is UUID 0xFFFA, app code 0x0D, a message counter, then the
// message. Decoding from offset+5 (the counter) shifted every field a byte.
if (!/payload\[offset \+ 4\] == 0x0D\)[\s\S]{0,80}&payload\[offset \+ 6\]/.test(fw))
    flockFail.push('BLE Remote ID must decode from offset+6 (after app code 0x0D and the counter)');

// The phone analyzer calls a capture Flock only under the detector's own rule
// (listed OUI + wildcard + IE), so its OUI list must be exactly the firmware's.
const ouiRe = /[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/g;
const fwOuis = ((fw.match(/const char\* flockOuis\[\] = \{([^}]*)\}/) || [])[1] || '').match(ouiRe) || [];
const appOuis = ((appSrc.match(/const FLOCK_OUIS = \[([^\]]*)\]/) || [])[1] || '').match(ouiRe) || [];
if (!fwOuis.length || fwOuis.slice().sort().join() !== appOuis.slice().sort().join())
    flockFail.push('app.js FLOCK_OUIS (' + appOuis.length + ') does not match firmware flockOuis[] (' + fwOuis.length + ')');

if (flockFail.length) {
    console.log('FAIL: Flock wildcard-probe signature:', flockFail);
    process.exit(1);
}
console.log('[signalsweep self-test] Flock wildcard-probe signature intact: ok');

// Band badges (Task 1): the detector must report the Wi-Fi channel per target.
// The 4 Hz hunt frame must reach a cable host too, not only BLE: over USB the
// meter otherwise updates at the 1 Hz push rate.
if (!/"hunt_rssi\\":%d\}"[\s\S]{0,400}?sendBleSerial\(buf\);[\s\S]{0,300}?Serial\.println\(buf\)/.test(fw)) { console.log('FAIL: hunt frame is not mirrored to USB'); process.exit(1); }
if (!/obj\["ch"\]\s*=\s*t\.wifiCh/.test(fw)) { console.log('FAIL: firmware does not emit "ch" (band badges)'); process.exit(1); }
// Band badges (Task 2): the app must ingest the channel it was just given.
if (!/\bch:\s*t\.ch\b/.test(appSrc)) { console.log('FAIL: app.js does not ingest "ch"'); process.exit(1); }
// Band badges (finding 1): the channel must come from the AP's own DS
// Parameter Set IE, not just the hopper's tuned rx_ctrl.channel -- 2.4 GHz
// adjacent-channel leakage makes rx_ctrl.channel alone lie about the band.
if (!/id == 3 && elen == 1[\s\S]{0,80}dsCh\s*=/.test(fw)) { console.log('FAIL: firmware does not read the DS Parameter Set into dsCh'); process.exit(1); }

// USB connect + capture recovery. The plugin's requestPermission `granted` is
// always false on Android 12+ (FLAG_IMMUTABLE strips the extra), so trusting it
// made "OK" read as "denied"; a start the board never acked, a dead stream, or
// a disconnect mid-capture all left the capture page waiting forever.
const usbFail = [];
if (/const \{ granted \} = await window\.UsbSerial\.requestPermission/.test(appSrc)) usbFail.push("trusts requestPermission's granted flag again");
if (!/UsbSerial\.hasPermission\(/.test(appSrc)) usbFail.push('connect no longer re-checks hasPermission');
if (!/addListener\('error'[\s\S]{0,400}?onDeviceDisconnected\(\)/.test(appSrc)) usbFail.push('USB stream error no longer disconnects');
if (!/sendCommand\(\{ raw: 'CMD:CAP:START:' \+ capReqSecs \}\);\s*capArmAck\(false\)/.test(appSrc)) usbFail.push('capture start watchdog not armed');
if (!/function handleCapStat\(cap\) \{\s*clearTimeout\(capAckTimer\)/.test(appSrc)) usbFail.push('cap frames no longer disarm the watchdog');
if (!/function onDeviceDisconnected\(\)[\s\S]{0,800}?if \(capturing\) capAbort\(/.test(appSrc)) usbFail.push('disconnect no longer ends a running capture');
// Back used to exitApp(): the page died, the BLE link and USB port did not, and
// the reopened app could not re-adopt them (reconcile queried before initialize).
if (/addListener\('backButton'[^\n]*exitApp/.test(appSrc)) usbFail.push('back button finishes the Activity again (exitApp)');
if (!/async function reconcileConnection\(\) \{(?:(?!getConnectedDevices)[\s\S])*?BleClient\.initialize\(/.test(appSrc)) usbFail.push('reconcileConnection queries BLE before initialize()');
if (!/async function teardownUsb\(\) \{[\s\S]{0,400}?usbRawQueue = \[\];/.test(appSrc)) usbFail.push('teardownUsb no longer drops queued chunks (stale push repaints a disconnected strip)');
if (!/if \(document\.hidden\) setTimeout\(drainUsbQueue/.test(appSrc)) usbFail.push('USB drain relies on rAF alone (never runs with the screen off)');
if (usbFail.length) { console.log('FAIL: USB connect/capture recovery:', usbFail); process.exit(1); }
console.log('[signalsweep self-test] USB connect/capture recovery intact: ok');

const results = await global.__signalsweepSelfTest();
const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
console.log('[signalsweep self-test]', results);
if (failed.length) {
    console.log('FAIL:', failed.join(', '));
    process.exit(1);
}
console.log('PASS');
process.exit(0);
