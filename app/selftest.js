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
// Deliberately unread: `cfg` is the discriminator itself, `alerts` is a
// bench-only counter with no UI.
const cfgIgnored = new Set(['cfg', 'alerts']);
const cfgUnread = cfgKeys.filter(k => !cfgIgnored.has(k) &&
    !appSrc.includes('cfg.' + k) && !appSrc.includes('data.' + k));
if (cfgKeys.length < 5 || cfgUnread.length) {
    console.log('FAIL: CMD:CFG fields the app never reads:', cfgUnread,
                '(parsed', cfgKeys.length, 'keys)');
    process.exit(1);
}
console.log('[signalsweep self-test] app reads every CMD:CFG field: ok');

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

const results = await global.__signalsweepSelfTest();
const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
console.log('[signalsweep self-test]', results);
if (failed.length) {
    console.log('FAIL:', failed.join(', '));
    process.exit(1);
}
console.log('PASS');
process.exit(0);
