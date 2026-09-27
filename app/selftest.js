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

// The Cameras tab is strictly ALPR + mass surveillance, and the firmware and the
// app each keep a keyword list that routes a category there. If the two drift,
// a vendor the app files under Cameras beeps GENERIC, which that tab's preset
// mutes -- a silent camera on the camera tab.
const kw = src => new Set([...src.matchAll(/indexOf\(["'](\w+)["']\)/g)].map(m => m[1]));
const fwAlpr = kw((readFileSync(new URL('../firmware/src/hardware_manager.cpp', import.meta.url), 'utf8')
    .match(/if \(c\.indexOf\("flock"\)[\s\S]*?return ALERT_ALPR;/) || [''])[0]);
const appAlpr = kw((appSrc.match(/if \(c\.indexOf\('flock'\)[\s\S]*?key: 'alpr'/) || [''])[0]);
if (!fwAlpr.has('soundthinking') || [...fwAlpr].sort().join() !== [...appAlpr].sort().join()) {
    console.log('FAIL: ALPR keyword drift: firmware', [...fwAlpr], 'app', [...appAlpr]);
    process.exit(1);
}
console.log('[signalsweep self-test] ALPR / mass-surveillance keywords match firmware: ok');

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

// `crash` is built with crashReportToJson(doc["crash"].to<JsonObject>()), not
// a plain `doc["crash"] =`, so the generic CMD:CFG-unread scan above never
// sees it -- assert both sides explicitly instead. (CRLF working copy: no
// literal \n in these regexes.)
{
    const bsrc = readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8');
    const fail = [];
    if (!/crashReportToJson\(doc\["crash"\]\.to<JsonObject>\(\)\)/.test(bsrc)) fail.push('firmware does not build cfg.crash');
    if (!/cfg\.crash/.test(appSrc)) fail.push('app never reads cfg.crash');
    if (fail.length) { console.log('FAIL:', fail.join('; ')); process.exit(1); }
    console.log('[signalsweep self-test] app reads cfg.crash: ok');
}

// Host time push: the app must send {"time"} paired with each CMD:CFG attempt
// (USB opens reset the board, so a lone push can land mid-boot and vanish),
// the firmware must parse it, and both sides must agree on the anchors key.
{
    const bsrc = readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8');
    const fail = [];
    if (!/doc\["time"\]\.is<uint32_t>\(\)/.test(bsrc)) fail.push('firmware does not parse {"time"}');
    const rc = (appSrc.match(/function requestConfig\(\) \{[\s\S]*?\n        \}/) || [''])[0];
    if (!/time:\s*Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/.test(rc)) fail.push('requestConfig does not push time');
    if (!/o\["epochs"\]/.test(bsrc)) fail.push('logrd header has no epochs');
    if (!/o\.epochs/.test(appSrc)) fail.push('app ignores logrd epochs');
    if (fail.length) { console.log('FAIL:', fail.join('; ')); process.exit(1); }
    console.log('[signalsweep self-test] host time push + log anchors wired both sides: ok');
}

// SD card: commands exist on both sides, and the router only sets flags --
// card I/O on the NimBLE host task is the stack-canary reboot again.
{
    const bsrc = readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8');
    const fail = [];
    for (const c of ['CMD:SD:LS', 'CMD:SD:GET:', 'CMD:SD:RM:']) {
        if (!bsrc.includes('"' + c)) fail.push('firmware lacks ' + c);
    }
    const router = (bsrc.match(/void processIncomingCommand\(const String& rawCommand\) \{[\s\S]*?\n\}/) || [''])[0];
    if (/\bsd(List|Read|Remove|Probe|Append|Stream\w*)\s*\(/.test(router)) fail.push('processIncomingCommand touches the card');
    if (/\bstartCapture\s*\(/.test(router)) fail.push('processIncomingCommand starts a capture on the host task');
    for (const c of ['CMD:SD:LS', 'CMD:SD:GET:', 'CMD:SD:RM:'])
        if (!appSrc.includes("'" + c)) fail.push('app never sends ' + c);
    if (!/data-sd-dl/.test(appSrc) || /onclick="sdDownload\('/.test(appSrc + htmlSrc))
        fail.push('card file names must ride data- attributes, never an onclick string');
    if (!/signalsweep-capture-' \+/.test(appSrc.slice(appSrc.indexOf('function sdSaveDownload')))) fail.push('card captures must save under the Survey list name pattern');
    // RM answers on its own key; the app must show the failure.
    if (!/\\"sdrm\\"/.test(bsrc) || !/data\.sdrm/.test(appSrc)) fail.push('RM failures must ride {"sdrm"} and the app must handle it');
    // A capture file that is never synced is 0 bytes after a power cut.
    const msrc = readFileSync(new URL('../firmware/src/mode_capture.cpp', import.meta.url), 'utf8');
    if (!/sdStreamSync\(/.test(msrc)) fail.push('the capture drain loop never syncs the card stream');
    // A download page is trusted only if its decoded bytes add up to `next`.
    if (!/pageBytes !== o\.next - st\.pageOff/.test(appSrc)) fail.push('SD download no longer checks each page for holes');
    if (fail.length) { console.log('FAIL:', fail.join('; ')); process.exit(1); }
    console.log('[signalsweep self-test] SD commands wired, router stays off the card: ok');
}

// Survey capture must be able to ask the board to write straight to the card.
{
    const fail = [];
    if (!/'CMD:CAP:START:' \+ capReqSecs \+ \(capToSd \? ':SD' : ''\)/.test(appSrc)) fail.push('Survey never asks the board to capture to the card');
    if (fail.length) { console.log('FAIL:', fail.join('; ')); process.exit(1); }
    console.log('[signalsweep self-test] Survey card-capture wired: ok');
}

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

// The easter egg is another shared index, with no reply to catch a drift: the
// device deliberately does not report `egg` anywhere, so a scene added on one
// side only would just light the wrong thing. And it must stay transient --
// persisting it would make a board come back from a power cycle as a
// flashlight instead of a detector, which is the headless rule inverted.
const eggFail = [];
const fwHdr = readFileSync(new URL('../firmware/src/hardware_manager.h', import.meta.url), 'utf8');
const fwEgg = ((fwHdr.match(/enum EggScene[^{]*\{([^}]*)\}/) || [])[1] || '').match(/EGG_([A-Z]+)/g) || [];
const appEgg = ((appSrc.match(/const EGG_SCENES = \[([^\]]*)\]/) || [])[1] || '').match(/'(\w+)'/g) || [];
const eggCount = Number((fwHdr.match(/#define EGG_COUNT (\d+)/) || [])[1]);
if (fwEgg.length !== eggCount) eggFail.push('EGG_COUNT is ' + eggCount + ' but EggScene has ' + fwEgg.length);
fwEgg.forEach((s, i) => {
    if (("'" + s.slice(4).toLowerCase() + "'") !== appEgg[i]) eggFail.push(s + ' vs ' + appEgg[i]);
    if (!htmlSrc.includes('data-egg="' + i + '"')) eggFail.push('no button for scene ' + i);
});
if (!/setEggScene\(\(uint8_t\)constrain\(doc\["egg"\]\.as<int>\(\), 0, EGG_COUNT - 1\)\)/
    .test(readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8')))
    eggFail.push('the egg command does not clamp to EGG_COUNT - 1');
const setEggBody = (hwSrc.match(/void setEggScene\([^)]*\) \{[\s\S]*?\n\}/) || [''])[0];
if (/Preferences|putUChar|NVS_NS/.test(setEggBody)) eggFail.push('setEggScene persists the scene');
if (!/eggUntil/.test(setEggBody)) eggFail.push('setEggScene does not re-arm the timeout');
if (!/if \(eggScene && \(int32_t\)\(now - eggUntil\) >= 0\) eggScene = EGG_OFF;/.test(hwSrc))
    eggFail.push('the egg never expires on its own');
if (!/THEME_CLASSIC \|\| ledMode == LED_ONE \|\| eggScene/.test(applyThemeBody))
    eggFail.push('applyTheme recolours the flashlight');
// Nobody holding a flashlight is hunting. Gated in noteAlert(), like the hunt
// target, so the alert log keeps matching what you actually heard.
const noteAlertBody = (readFileSync(new URL('../firmware/src/mode_watchers_watch.cpp', import.meta.url), 'utf8')
    .match(/static bool noteAlert\([^)]*\) \{[\s\S]*?\n\}/) || [''])[0];
if (!/getEggScene\(\) != EGG_OFF/.test(noteAlertBody))
    eggFail.push('alerts still sound during the easter egg');
if (eggFail.length) { console.log('FAIL: easter egg:', eggFail); process.exit(1); }
console.log('[signalsweep self-test] egg scenes match firmware EggScene, transient: ok');

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
if (!(ver >= 8)) flockFail.push('SIG_SCHEMA_VERSION is ' + ver + ', expected >= 8');

// Genetec / Ubicquia are label-only: OUI and nothing else (W_OUI 30 can neither
// list nor beep), and a category that routes to 'other', never a camera tab.
const catKw = kw((appSrc.match(/function categoryOf\([\s\S]*?key: 'other'/) || [''])[0]);
for (const v of ['Genetec', 'Ubicquia']) {
    const rules = [...fw.matchAll(new RegExp('addRule\\("[^"]*' + v + '[^"]*", "([^"]*)", "([^"]*)", "([^"]*)", "([^"]*)", "([^"]*)"\\);', 'g'))];
    if (!rules.length) flockFail.push(v + ' label-only rule missing');
    for (const [r, cat, oui, ...rest] of rules) {
        if (!oui || rest.some(Boolean)) flockFail.push(v + ' rule is not OUI-only: ' + r);
        const hit = [...catKw].find(k => cat.toLowerCase().includes(k));
        if (!catKw.size || hit) flockFail.push(v + ' category "' + cat + '" hits routing keyword "' + hit + '", expected other');
    }
}

// 2026-09-21 firmware-dump cleanups. The Falcon hotspot is "Flock-" + 6 chars; a
// bare "flock" substring beeped for a TP-Link router named FlockNation.
if (/ssidStr\.indexOf\("flock"\)/.test(fw) || !/ssidStr\.startsWith\("flock-"\)/.test(fw))
    flockFail.push('Flock SSID match must be the "flock-" prefix, not a substring');
// 0x09C8 alone is not Flock; the battery is matched in code with a second fact.
if (/addRule\([^)]*"0x09C8"/i.test(fw)) flockFail.push('standalone 0x09C8 rule is back in the defaults');
const peng = (fw.match(/static bool blePenguin\([\s\S]*?\n\}/) || [''])[0];
if (!peng) flockFail.push('blePenguin() missing');
// A bare 10-digit name counts only after the 0x09C8 check: Apple Nearby Info
// sends the placeholder name "0102000000".
else if (peng.indexOf('isTenDigits(name, 0)') < peng.indexOf('0x09')) flockFail.push('blePenguin accepts a bare 10-digit name without mfg 0x09C8');

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
// The only SSID Flock firmware builds is "Flock-" + 6 chars (WifiApService,
// 2026-09-21 dump). A substring rule ("fs_", "pigvision") beeps at "Chiefs_Guest":
// a Ubiquiti AP logged as ALPR on a 2026-09-25 drive.
const ssidRule = (fw.match(/if \(!ssidHit &&[\s\S]{0,200}?\)\) \{/) || [''])[0];
if (!/startsWith\("flock-"\)/.test(ssidRule) || !/length\(\) == 12/.test(ssidRule))
    flockFail.push('Flock SSID rule must be the "flock-" prefix at exactly 12 chars');
if (/indexOf\(/.test(ssidRule)) flockFail.push('Flock SSID rule matches a substring again (fs_/pigvision) -- false positives on ordinary networks');

// BLE Remote ID is UUID 0xFFFA, app code 0x0D, a message counter, then the
// message. Decoding from offset+5 (the counter) shifted every field a byte.
if (!/payload\[offset \+ 4\] == 0x0D\)[\s\S]{0,80}&payload\[offset \+ 6\]/.test(fw))
    flockFail.push('BLE Remote ID must decode from offset+6 (after app code 0x0D and the counter)');

// The phone analyzer calls a capture Flock only under the detector's own rule
// (listed OUI + wildcard + IE), so its OUI list must be exactly the firmware's:
// the community flockOuis[] loop plus every literal addRule(..., "Flock
// Safety", "<oui>", ...) (the IEEE-registered b4:1e:52 block lives as its own
// rule, not in the loop, but still sets flockOui -- see line ~1364).
const ouiRe = /[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/g;
const fwLoopOuis = ((fw.match(/const char\* flockOuis\[\] = \{([^}]*)\}/) || [])[1] || '').match(ouiRe) || [];
const fwRuleOuis = [...fw.matchAll(/addRule\("[^"]+",\s*"Flock Safety",\s*"([0-9a-fA-F:]{8})"/g)].map(m => m[1]);
const fwOuis = [...new Set([...fwLoopOuis, ...fwRuleOuis])];
const appOuis = ((appSrc.match(/const FLOCK_OUIS = \[([^\]]*)\]/) || [])[1] || '').match(ouiRe) || [];
if (!fwOuis.length || fwOuis.slice().sort().join() !== appOuis.slice().sort().join())
    flockFail.push('app.js FLOCK_OUIS (' + appOuis.length + ') does not match firmware flockOuis[] + registered Flock Safety rules (' + fwOuis.length + ')');

if (flockFail.length) {
    console.log('FAIL: Flock wildcard-probe signature:', flockFail);
    process.exit(1);
}
console.log('[signalsweep self-test] Flock wildcard-probe signature intact: ok');

// Band badges (Task 1): the detector must report the Wi-Fi channel per target.
// The 4 Hz hunt frame must reach a cable host too, not only BLE: over USB the
// meter otherwise updates at the 1 Hz push rate.
if (!/"hunt_rssi\\":%d\}"[\s\S]{0,400}?sendBleSerial\(buf\);[\s\S]{0,300}?sendUsbLine\(buf\)/.test(fw)) { console.log('FAIL: hunt frame is not mirrored to USB'); process.exit(1); }
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
if (!/sendCommand\(\{ raw: 'CMD:CAP:START:' \+ capReqSecs \+ \(capToSd \? ':SD' : ''\) \}\);\s*capArmAck\(false\)/.test(appSrc)) usbFail.push('capture start watchdog not armed');
if (!/function handleCapStat\(cap\) \{\s*(\/\/[^\n]*\n\s*)*if \(!capturing\) return;\s*clearTimeout\(capAckTimer\)/.test(appSrc)) usbFail.push('cap frames no longer disarm the watchdog');
if (!/function onDeviceDisconnected\(\)[\s\S]{0,1200}?if \(capturing\) capAbort\(/.test(appSrc)) usbFail.push('disconnect no longer ends a running capture');
// Back used to exitApp(): the page died, the BLE link and USB port did not, and
// the reopened app could not re-adopt them (reconcile queried before initialize).
if (/addListener\('backButton'[^\n]*exitApp/.test(appSrc)) usbFail.push('back button finishes the Activity again (exitApp)');
if (!/async function reconcileConnection\(\) \{(?:(?!getConnectedDevices)[\s\S])*?BleClient\.initialize\(/.test(appSrc)) usbFail.push('reconcileConnection queries BLE before initialize()');
if (!/async function teardownUsb\(\) \{[\s\S]{0,400}?usbRawQueue = \[\];/.test(appSrc)) usbFail.push('teardownUsb no longer drops queued chunks (stale push repaints a disconnected strip)');
if (!/if \(document\.hidden\) setTimeout\(drainUsbQueue/.test(appSrc)) usbFail.push('USB drain relies on rAF alone (never runs with the screen off)');
if (usbFail.length) { console.log('FAIL: USB connect/capture recovery:', usbFail); process.exit(1); }
console.log('[signalsweep self-test] USB connect/capture recovery intact: ok');

// Alert log. The 16-byte record is a wire contract between alert_log.h and the
// parser in app.js, and the whole design rests on two things the compiler
// cannot check: the layout matching, and the flash write never happening on a
// radio callback (a LittleFS write is tens of ms; both callbacks must stay fast,
// and the BLE one holds watchersMutex).
const logSrc = readFileSync(new URL('../firmware/src/alert_log.h', import.meta.url), 'utf8');
const wwSrc  = readFileSync(new URL('../firmware/src/mode_watchers_watch.cpp', import.meta.url), 'utf8');
const hwSrc2 = readFileSync(new URL('../firmware/src/hardware_manager.h', import.meta.url), 'utf8');
const logFail = [];

const recSize = (logSrc.match(/#define\s+ALERT_LOG_REC_SIZE\s+(\d+)/) || [])[1];
if (recSize !== '16') logFail.push(`ALERT_LOG_REC_SIZE is ${recSize}, app.js parses 16-byte records`);
if (!/for \(let i = 0; i \+ 16 <= bytes\.length; i \+= 16\)/.test(appSrc)) logFail.push('app.js no longer strides 16-byte records');
// Field offsets, as the header documents them and the parser reads them.
[['boot', 0], ['secs', 2], ['mac', 6], ['cat', 12], ['rule', 13], ['rssi', 14]].forEach(([f, off]) => {
    if (!new RegExp(`^//\\s+${off}\\s+\\d+\\s+${f}\\b`, 'm').test(logSrc)) logFail.push(`alert_log.h no longer documents ${f} at offset ${off}`);
});
if (!/bytes\[i\] \| \(bytes\[i \+ 1\] << 8\)/.test(appSrc)) logFail.push('app.js boot field moved off offset 0');
if (!/bytes\[i \+ 12\]/.test(appSrc)) logFail.push('app.js category field moved off offset 12');
if (!/bytes\[i \+ 13\]/.test(appSrc)) logFail.push('app.js rule index moved off offset 13');
if (!/\(bytes\[i \+ 14\] << 24\) >> 24/.test(appSrc)) logFail.push('app.js rssi moved off offset 14, or stopped sign-extending');

const maxRecs = (logSrc.match(/#define\s+ALERT_LOG_MAX_RECS\s+(\d+)/) || [])[1];
const appMax  = (appSrc.match(/const LOG_MAX_RECS = (\d+)/) || [])[1];
if (!maxRecs || maxRecs !== appMax) logFail.push(`ring capacity drifted: firmware ${maxRecs}, app ${appMax} (the fill gauge would lie)`);
// The bench env shrinks it with -D, so it has to stay overridable.
if (!/#ifndef ALERT_LOG_MAX_RECS/.test(logSrc)) logFail.push('ALERT_LOG_MAX_RECS is no longer overridable (the logtest bench env cannot shrink the ring)');

// Category byte order == AlertCategory order, or every logged alert reads back
// as the wrong kind of device.
const enumOrder = (hwSrc2.match(/enum AlertCategory \{([\s\S]*?)\}/) || [, ''])[1]
    .split('\n').map(l => (l.match(/ALERT_([A-Z]+)/) || [])[1]).filter(Boolean);
const appCats = (appSrc.match(/const LOG_CATS = \[([^\]]*)\]/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
const catWord = { ALPR: 'alpr', BODYCAM: 'body', DRONE: 'drone', TRACKER: 'tracker', GENERIC: 'other' };
if (enumOrder.length !== appCats.length) {
    logFail.push(`LOG_CATS has ${appCats.length} entries, AlertCategory has ${enumOrder.length}`);
} else {
    enumOrder.forEach((e, i) => {
        const want = catWord[e];
        if (!want || !appCats[i].toLowerCase().includes(want)) {
            logFail.push(`LOG_CATS[${i}] is "${appCats[i]}" but AlertCategory[${i}] is ALERT_${e}`);
        }
    });
}

// The write must not be on the detection path. noteAlertForTarget() runs on both
// radio callbacks: it may only set a flag.
const noteFn = (wwSrc.match(/static void noteAlertForTarget\([\s\S]*?\n\}/) || [''])[0];
if (/alertLogWrite\(/.test(noteFn)) logFail.push('alertLogWrite() called from noteAlertForTarget -- that is a radio callback, and a LittleFS write is tens of ms');
if (!/t\.logPending = true/.test(noteFn)) logFail.push('noteAlertForTarget no longer flags the target for logging');
// ...and it must follow the alert decision, so a muted category and an active
// hunt (both refused by noteAlert) write nothing.
if (!/if \(noteAlert\([\s\S]{0,900}?logPending = true/.test(noteFn)) logFail.push('logPending set outside the noteAlert() gate -- muted categories or hunts would be logged');
// The flush happens after the mutex is released: holding it across flash I/O
// would stall the BLE scan callback for exactly as long as the write took. So
// the mutex must be given back between collecting the pending records (inside
// the lock) and writing them. Newline-agnostic on purpose -- the working copy
// is CRLF on Windows, and a literal \n here silently passed on LF and failed on
// CRLF.
const collectAt = wwSrc.indexOf('toLog.push_back');
const writeAt = wwSrc.indexOf('alertLogWrite(p.mac');
if (collectAt < 0 || writeAt < 0 || writeAt < collectAt ||
    !wwSrc.slice(collectAt, writeAt).includes('xSemaphoreGive(watchersMutex)')) {
    logFail.push('alert log flush no longer happens after xSemaphoreGive -- flash I/O under the detection mutex');
}
if (!/alertLogTick\(\);/.test(wwSrc)) logFail.push('the 1 Hz task no longer ticks the log clock (millis rollover would rewind the ordering key)');

if (logFail.length) { console.log('FAIL: alert log:', logFail); process.exit(1); }
console.log('[signalsweep self-test] alert log record + write path: ok');

// Reassembler resync: a BLE notification that opens a known message drops a
// stale partial (a torn push glued onto the next reply lost both on the bench).
// BLE only -- a USB/serial byte stream splits anywhere, so resyncing there would
// throw away good lines.
{
    const rs = [];
    const chunkFn = (appSrc.match(/function processIncomingChunk\([\s\S]*?\n {8}\}/) || [''])[0];
    if (!/RX_MSG_START\s*=\s*\/\^\(/.test(appSrc)) rs.push('RX_MSG_START pattern missing');
    if (!/if \(isBle && rxBuffer && RX_MSG_START\.test\(chunk\)\)/.test(chunkFn)) rs.push('processIncomingChunk no longer resyncs (BLE-gated) on a message start');
    if (!/rxDropped\+\+/.test(chunkFn)) rs.push('a resync drop is no longer counted as a dropped update');
    const calls = appSrc.match(/processIncomingChunk\([^)]*\)/g) || [];
    const ble = calls.filter(c => /, true\)$/.test(c)).length;
    if (ble !== 2) rs.push(`expected 2 BLE call sites passing true, found ${ble}`);
    if (!/processIncomingChunk\(text\)/.test(appSrc) || !/processIncomingChunk\(value\)/.test(appSrc)) rs.push('USB/serial call sites must not pass the BLE flag');
    // Bulk card/log replies pace per line (the 2 ms per-notification yield
    // lost the tail of a 3.6 KB SD:GET over BLE), and every high-rate USB
    // line goes through the mutex (the push landed inside an SDF: line).
    const bs = readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8');
    const ww = readFileSync(new URL('../firmware/src/mode_watchers_watch.cpp', import.meta.url), 'utf8');
    if ((bs.match(/vTaskDelay\(pdMS_TO_TICKS\(BULK_LINE_PACE_MS\)\)/g) || []).length !== 2) rs.push('sendSdFile/sendAlertLog no longer pause BULK_LINE_PACE_MS per line');
    const getLines = +((bs.match(/#define SD_GET_LINES\s+(\d+)/) || [])[1]);
    if (!(getLines >= 1 && getLines <= 8)) rs.push('SD_GET_LINES (lines per CMD:SD:GET page) must be 1..8');
    if (!/sent >= SD_GET_LINES \* batch/.test(bs)) rs.push('the SD page no longer scales with the line size');
    if (!/static void sendReply[\s\S]{0,120}?sendUsbLine\(payload\)/.test(bs)) rs.push('sendReply bypasses the USB line mutex');
    if (!/sendBleSerial\(jsonStr\);\s*sendUsbLine\(jsonStr\)/.test(ww)) rs.push('the 1 Hz push bypasses the USB line mutex');
    if (rs.length) { console.log('FAIL: rx resync:', rs); process.exit(1); }
    console.log('[signalsweep self-test] BLE-only reassembler resync: ok');
}

// BLE backpressure, the root cause of the torn/lost messages. notify() in both
// NimBLE-Arduino versions drops a notification silently when the mbuf pool is
// full; sendBleSerial() must go through notifyChunk(), which sees the result
// and resends the same chunk on a full queue, bounded.
{
    const rs = [];
    const bs = readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8');
    const cap = readFileSync(new URL('../firmware/src/mode_capture.cpp', import.meta.url), 'utf8');
    const ww = readFileSync(new URL('../firmware/src/mode_watchers_watch.cpp', import.meta.url), 'utf8');
    const appSrc = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
    const nc = (bs.match(/static bool notifyChunk\([\s\S]*?\n\}/) || [''])[0];
    if (!/ble_hs_mbuf_from_flat\(/.test(nc) || !/ble_gattc_notify_custom\(/.test(nc)) rs.push('notifyChunk no longer calls the host API where the result is visible');
    if (!/rc != BLE_HS_ENOMEM && rc != BLE_HS_EBUSY\) return false/.test(nc)) rs.push('notifyChunk no longer retries only on a full queue');
    if (!/for \(;;\)[\s\S]*vTaskDelay\(pdMS_TO_TICKS\(NOTIFY_RETRY_MS\)\)/.test(nc)) rs.push('notifyChunk no longer waits and resends the same chunk');
    if (!/NOTIFY_GIVEUP_MS\) return false/.test(nc) && !/>= giveUp\) return false/.test(nc)) rs.push('notifyChunk retry is no longer bounded');
    // The S3 drains ~1 x 512 B notification per ~300 ms on a phone link (bench
    // 2026-09-26: single waits up to 493 ms), so a 300 ms bound cut every bulk
    // reply at the 12-block pool. Short only on the NimBLE host task, where
    // the wait cannot be satisfied.
    if (!/xTaskGetCurrentTaskHandle\(\) == nimbleHostTask\s*\?\s*NOTIFY_GIVEUP_HOST_MS\s*:\s*NOTIFY_GIVEUP_MS/.test(nc)) rs.push('notifyChunk no longer waits longer off the NimBLE host task (bulk replies cut at 12 x 512 B on the S3)');
    if (!/nimbleHostTask = xTaskGetCurrentTaskHandle\(\);/.test(bs)) rs.push('onWrite no longer records the NimBLE host task');
    const sbs = (bs.match(/void sendBleSerial\([\s\S]*?\n\}/) || [''])[0];
    if (!/notifyChunk\(/.test(sbs)) rs.push('sendBleSerial bypasses notifyChunk');
    if (/->notify\(/.test(bs)) rs.push('a bare notify() is back (it drops silently on a full pool)');
    if (!/while \(ok && offset < length\)/.test(sbs)) rs.push('sendBleSerial keeps sending a message after a chunk was given up on');
    if (!/static const size_t BLE_ATT_MAX_ATTR_LEN = 512;/.test(bs)) rs.push('the 512-byte BLE attribute cap is no longer a named constant');
    if (!/if \(attrLen > BLE_ATT_MAX_ATTR_LEN\) attrLen = BLE_ATT_MAX_ATTR_LEN;/.test(bs)) rs.push('bulkLineBytes no longer clamps the attribute length to 512 before sizing a line (the 513-byte SDF: line bug)');
    if (!/\(attrLen - 5\) \/ 4\) \* 3/.test(bs) || !/if \(n < 48\) n = 48;/.test(bs)) rs.push('bulkLineBytes no longer sizes a BLE line to one notification');
    if (!/if \(maxChunkSize > BLE_ATT_MAX_ATTR_LEN\) maxChunkSize = BLE_ATT_MAX_ATTR_LEN;/.test(sbs)) rs.push('sendBleSerial no longer clamps its chunk size to the 512-byte attribute cap');
    if (!/perLine = bulkLineBytes\(viaBle\) \/ ALERT_LOG_REC_SIZE/.test(bs)) rs.push('LOG: lines no longer carry whole 16-byte records');
    if (!/\\"done\\":true,\\"off\\":%u,\\"next\\":%u/.test(bs)) rs.push('the sdget done frame no longer echoes its request offset');
    if (!/'off' in o && o\.off !== st\.pageOff/.test(appSrc) || !/if \(o\.off !== st\.pageOff\) return;/.test(appSrc)) rs.push('the app no longer ignores a stale sdget header/done');
    if (!/if \(isCapturingToUsb\(\)\) \{ sendReply\("\{\\"sdget\\":\{\\"err\\":\\"busy\\"\}\}"\)/.test(bs)) rs.push('CMD:SD:GET is no longer refused during a USB capture');
    if (/Serial\.print\("CAP:"\)/.test(cap) || !/sendUsbLine\("CAP:", b64, olen\)/.test(cap)) rs.push('CAP: lines bypass the USB line mutex');
    if (!/static void capReply[\s\S]{0,80}?sendUsbLine\(/.test(cap)) rs.push('capReply bypasses the USB line mutex');
    if (/Serial\.printf\("\[ALERT\]/.test(ww)) rs.push('[ALERT] bypasses the USB line mutex');
    // A pulled card must not list as a healthy empty one (bench, 2026-09-26).
    const sd = readFileSync(new URL('../firmware/src/sd_store.cpp', import.meta.url), 'utf8');
    if (!/if \(!dir\) \{ fail\(\); return 0; \}/.test(sd)) rs.push('sdList no longer treats a failed directory open as a card failure');
    if (!/if \(wasOk && sdState\(\) != SD_OK && sdProbe\(\)\)/.test(bs)) rs.push('sendSdList no longer re-probes a card that failed during the listing');
    if (rs.length) { console.log('FAIL: BLE backpressure:', rs); process.exit(1); }
    console.log('[signalsweep self-test] BLE backpressure + page checks: ok');
}

// ---------------------------------------------------------------------------
// Signature schema (SquachWatch extraction, Phase 1). A rule may carry its own
// weight (registered-maker OUIs list at 60 without beeping) and an SSID prefix
// (Axon body cams in pairing mode). Both must survive every path a rule takes:
// the struct, the loader, and the writer a pushed rule set goes through --
// updateWatchersSignaturesJson() rebuilds each rule field by field, so a field
// it forgets is silently dropped the first time the app saves.
const sigFail = [];
const wwHdr = readFileSync(new URL('../firmware/src/mode_watchers_watch.h', import.meta.url), 'utf8');
if (!/int\s+weight\s*=\s*0;/.test(wwHdr)) sigFail.push('WatcherSignature has no `int weight = 0;`');
if (!/String\s+ssidPrefix;/.test(wwHdr)) sigFail.push('WatcherSignature has no `String ssidPrefix;`');
if (!/sig\.weight\s*=\s*s\["weight"\]/.test(wwSrc)) sigFail.push('loader never reads "weight"');
if (!/sig\.ssidPrefix\s*=\s*s\["ssid_prefix"\]/.test(wwSrc)) sigFail.push('loader never reads "ssid_prefix"');
if (!/ns\["weight"\]\s*=/.test(wwSrc)) sigFail.push('updateWatchersSignaturesJson drops "weight" from pushed rules');
if (!/ns\["ssid_prefix"\]\s*=/.test(wwSrc)) sigFail.push('updateWatchersSignaturesJson drops "ssid_prefix" from pushed rules');

const matchFn = (wwSrc.match(/static int matchDeviceAgainstRule\([\s\S]*?\r?\n\}/) || [''])[0];
const uuidFn  = (wwSrc.match(/static bool uuidMatches\([\s\S]*?\r?\n\}/) || [''])[0];
// The v5 Raven removal: a 4-digit needle matched as a substring hits random
// 128-bit UUIDs, and at W_UUID (70) one hit beeps.
if (!uuidFn) sigFail.push('no uuidMatches() helper');
if (/indexOf/.test(uuidFn) || /Check Service UUID[\s\S]*?indexOf[\s\S]*?W_UUID/.test(matchFn))
    sigFail.push('service UUID matched as a substring again');
if (!/bitSize\(\)\s*==\s*16/.test(uuidFn)) sigFail.push('uuidMatches() has no exact 16-bit arm');
if (!/uuidMatches\(/.test(matchFn)) sigFail.push('matchDeviceAgainstRule() does not use uuidMatches()');
if (!/sig\.ssidPrefix\.length\(\)\s*>\s*0\)\s*return 0;/.test(matchFn)) sigFail.push('SSID rules can match on BLE');
if (!/if \(sig\.weight > 0\) weight = sig\.weight;/.test(matchFn)) sigFail.push('BLE matcher ignores rule weight');

if (!/\(ouiOnly && sig\.weight > 0\) \? sig\.weight : W_WIFI_OUI/.test(wwSrc)) sigFail.push('Wi-Fi OUI path awards rule weight on a partial match (mfg_id/device_name/service_uuid unchecked on Wi-Fi)');
if (!/\(ouiOnly && sig\.weight > 0\) \? sig\.weight : W_WIFI_SSID/.test(wwSrc)) sigFail.push('SSID-prefix pass awards rule weight on a partial match (mfg_id/device_name/service_uuid unchecked on Wi-Fi)');
if (!/foundSsid\.startsWith\(sig\.ssidPrefix\)/.test(wwSrc)) sigFail.push('SSID prefix not matched as a case-sensitive prefix of the broadcast SSID');

// Fix: a rule's OUI/mfg_id/device_name/service_uuid conditions are an AND. On
// Wi-Fi only the OUI (or SSID prefix) can actually be checked, so a rule that
// also states a BLE-only condition must never get its own `weight` from a
// Wi-Fi partial match -- and the SSID-prefix pass must not skip a rule's OUI
// condition either. Both passes need the same "no BLE-only condition" guard.
const ouiOnlyGuards = (wwSrc.match(/sig\.mfgId\.length\(\)\s*==\s*0\s*&&\s*sig\.deviceName\.length\(\)\s*==\s*0\s*&&\s*sig\.serviceUuid\.length\(\)\s*==\s*0/g) || []).length;
if (ouiOnlyGuards < 2) sigFail.push('Wi-Fi OUI and SSID-prefix passes must each require a rule to have no BLE-only conditions before applying its own weight');
const ouiChecks = (wwSrc.match(/cleanMac\.startsWith\(cleanOui\)/g) || []).length;
if (ouiChecks < 2) sigFail.push('SSID-prefix pass does not also require the frame source MAC to match the rule\'s OUI');
if (!/matchedRule = sig\.name\.length\(\) > 0 \? sig\.name : "SSID prefix match"/.test(wwSrc)) sigFail.push('SSID-prefix pass has no fallback rule name (falls back to an empty String)');

if (sigFail.length) { console.log('FAIL: signature schema:', sigFail); process.exit(1); }
console.log('[signalsweep self-test] signature schema (weight, ssid_prefix): ok');

// ---------------------------------------------------------------------------
// Registry pin. Every default OUI rule written as a literal addRule() must be
// registered by the IEEE to the company its name claims. SquachWatch-CYD
// shipped Sonos as "Vigilant" for eleven releases; we shipped Fiberblaze and
// Bitworks as "Sierra Wireless". A re-import from someone else's table fails
// here. The Flock community list (flockOuis[], added in a loop) is exempt on
// purpose: it is the module makers Flock builds on, gated by the wildcard probe.
const regFail = [];
const ouiReg = new Map(readFileSync(new URL('./public/oui.txt', import.meta.url), 'utf8')
    .split(/\r?\n/).map(l => l.split('\t')).filter(p => p.length >= 2)
    .map(([k, v]) => [k.trim().toUpperCase(), v.trim()]));
const OUI_OWNER = {
    'Flock Safety MAC (registered block)': 'Flock Safety',
    'SoundThinking': 'ShotSpotter',
    'Axon Enterprise device': 'Axon Enterprise',
    'Cradlepoint Router': 'CradlePoint',
    'Peplink Router': 'PePWave',
    'Sierra Wireless Infrastructure': 'Sierra Wireless',
    'Genetec (AutoVu / Sharp)': 'Genetec',
    'Ubicquia (streetlight node)': 'Ubicquia',
    'Motorola Solutions device': 'Motorola Solutions',
    'Verkada camera': 'Verkada',
    'Avigilon Alta device': 'Avigilon Alta',
    'Axis Communications camera': 'Axis Communications',
    'Flipper Devices (MAC)': 'Flipper Devices'
};
const defaults = (wwSrc.match(/auto addRule = [\s\S]*?serializeJsonPretty\(doc, file\)/) || [''])[0];
let ouiRules = 0;
// The category argument may be the HACKING_GEAR_CATEGORY macro, not a literal.
for (const [, name, oui] of defaults.matchAll(/addRule\("([^"]+)",\s*(?:"[^"]*"|HACKING_GEAR_CATEGORY),\s*"([0-9a-fA-F:]{8})"/g)) {
    ouiRules++;
    const owner = ouiReg.get(oui.replace(/:/g, '').toUpperCase());
    // Deliberately unregistered prefixes, each with the reason it may exist,
    // and never above "listed, no beep" (checked below).
    const UNREGISTERED_OK = {
        '80:e1:26': 'ST STM32WB derived BLE address; a Flipper Zero uses it, so do other STM32WB devices',
        '80:e1:27': 'ST STM32WB derived BLE address; a Flipper Zero uses it, so do other STM32WB devices'
    };
    if (UNREGISTERED_OK[oui.toLowerCase()] && !owner) continue;
    const want = OUI_OWNER[name];
    if (!want) regFail.push(`OUI rule "${name}" (${oui}) has no registrant pinned in OUI_OWNER`);
    else if (!owner || !owner.toLowerCase().includes(want.toLowerCase()))
        regFail.push(`"${name}" ${oui} is registered to "${owner || 'nobody'}", not ${want}`);
}
if (ouiRules < 20) regFail.push(`only ${ouiRules} literal OUI rules parsed -- the regex drifted`);
// Meta's company IDs are on Quest headsets too; they must never name a row "Smart glasses".
if (/0x01AB|0x058E/i.test(defaults)) regFail.push('Meta company ID 0x01AB/0x058E added as a default rule');
// Ray-Ban/Oakley Meta glasses: each signal alone is a false-positive magnet
// (fd5f is plausibly on Meta's own Quest headsets too; the Luxottica company
// ID alone is weak), so the combined rule must carry BOTH in the same
// addRule call -- no default rule may state either one without the other.
for (const call of defaults.match(/addRule\([^;]*\);/g) || []) {
    const hasFd5f = /fd5f/i.test(call);
    const hasLux = /0x0D53/i.test(call);
    if (hasFd5f !== hasLux) regFail.push(`glasses rule states fd5f/0x0D53 without the other: ${call.replace(/\s+/g, ' ')}`);
}
if (!/#define SIG_SCHEMA_VERSION 10\b/.test(wwSrc)) regFail.push('SIG_SCHEMA_VERSION not bumped to 10');
const hwCpp = readFileSync(new URL('../firmware/src/hardware_manager.cpp', import.meta.url), 'utf8');
if (!/c\.indexOf\("glasses"\)[^;]*\)\s*return ALERT_BODYCAM;/.test(hwCpp)) regFail.push('firmware does not route "glasses" to ALERT_BODYCAM');
// Every default company-ID rule must name the company the Bluetooth SIG
// registers that ID to. ESP32 Marauder comments Flipper's ID as 0x0FBA --
// that is a headset maker; Flipper Devices is 0x0E29. bt-company.txt keys
// are decimal.
const sigCo = new Map(readFileSync(new URL('./public/bt-company.txt', import.meta.url), 'utf8')
    .split(/\r?\n/).map(l => l.split('\t')).filter(p => p.length >= 2)
    .map(([k, v]) => [parseInt(k, 10), v.trim()]));
const MFG_OWNER = {
    'Flipper Devices (company ID)': 'Flipper Devices',
    'Ray-Ban / Oakley Meta glasses': 'Luxottica',
    'Snap Spectacles': 'Snapchat'
};
let mfgRules = 0;
for (const [, name, mfg] of defaults.matchAll(/addRule\("([^"]+)",\s*(?:"[^"]*"|HACKING_GEAR_CATEGORY),\s*"[^"]*",\s*"(0x[0-9a-fA-F]{4})"/g)) {
    mfgRules++;
    const owner = sigCo.get(parseInt(mfg, 16));
    const want = MFG_OWNER[name];
    if (!want) regFail.push(`company-ID rule "${name}" (${mfg}) has no registrant pinned in MFG_OWNER`);
    else if (!owner || !owner.toLowerCase().includes(want.toLowerCase()))
        regFail.push(`"${name}" ${mfg} is registered to "${owner || 'nobody'}", not ${want}`);
}
if (mfgRules < 3) regFail.push(`only ${mfgRules} literal company-ID rules parsed -- the regex drifted`);
// Scan the rule calls only: the comments above them name these values on purpose.
const ruleCalls = (defaults.match(/addRule\([^;]*\);/g) || []).join('\n');
if (/0x0FBA/i.test(ruleCalls)) regFail.push('0x0FBA added as Flipper -- it is a headset maker');
// 80:E1:26/27 is ST's STM32WB address derivation: a Flipper Zero uses it, but
// so does other STM32WB hardware. Allowed only as a listed-no-beep (60)
// "Hacking gear" hint whose name says what the signal proves -- never "Flipper".
for (const oui of ['80:e1:26', '80:e1:27']) {
    const call = (ruleCalls.match(new RegExp(`addRule\\([^;]*"${oui}"[^;]*\\);`, 'i')) || [''])[0];
    if (!call) regFail.push(`no ${oui} STM32WB rule`);
    else if (!/HACKING_GEAR_CATEGORY/.test(call) || !/,\s*60\)\s*;$/.test(call) || !/STM32WB/.test(call) || /"Flipper/.test(call))
        regFail.push(`${oui} rule must be Hacking gear, weight 60, named STM32WB, not "Flipper...": ${call.replace(/\s+/g, ' ')}`);
}
// The attack-gear defaults exist, all under "Hacking gear".
for (const want of ['"3081"', '"3082"', '"3083"', '"0x0E29"', '"0c:fa:22"', '"flipper"', '"Pineapple_"', '"pwned"'])
    if (!new RegExp(`addRule\\([^;]*HACKING_GEAR_CATEGORY[^;]*${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(defaults))
        regFail.push(`no "Hacking gear" default rule carries ${want}`);
if (regFail.length) { console.log('FAIL: registry:', regFail); process.exit(1); }
console.log(`[signalsweep self-test] ${ouiRules} default OUI rules match the IEEE registry: ok`);

// ---------------------------------------------------------------------------
// Per-device Ignore. It is a beep gate, never a detection gate, and it must
// sit before noteAlert() inside noteAlertForTarget() WITHOUT setting alerted:
// otherwise un-ignoring a device that is still here stays silent until it goes
// stale -- the bug the beep mask already avoids.
const igFail = [];
const noteFnIg = (wwSrc.match(/static void noteAlertForTarget\([\s\S]*?\r?\n\}/) || [''])[0];
const igAt = noteFnIg.indexOf('isIgnoredLocked(t.mac)');
if (igAt < 0) igFail.push('noteAlertForTarget() has no ignore gate');
if (igAt > noteFnIg.indexOf('noteAlert(')) igFail.push('ignore gate comes after noteAlert()');
if (!/isIgnoredLocked\(t\.mac\)\)\s*return;/.test(noteFnIg)) igFail.push('ignore gate does more than return (it must not touch t.alerted)');
if (!/#define IGNORE_MAX 16/.test(wwHdr)) igFail.push('IGNORE_MAX is not 16 in mode_watchers_watch.h');
if (!/const IGNORE_MAX = 16;/.test(appSrc)) igFail.push('app IGNORE_MAX drifted from firmware');
if (!/getBytesLength\("ignore"\)/.test(wwSrc) || !/%\s*sizeof\(IgnoreEntry\)/.test(wwSrc))
    igFail.push('restore does not validate the ignore blob length (a format change would read garbage MACs)');
const bsSrc = readFileSync(new URL('../firmware/src/ble_serial.cpp', import.meta.url), 'utf8');
if (!/doc\["ignore"\]\.is<const char\*>\(\)/.test(bsSrc) || !/doc\["unignore"\]\.is<const char\*>\(\)/.test(bsSrc))
    igFail.push('router has no ignore/unignore command');
if (!/getIgnoreJson\(/.test(bsSrc)) igFail.push('CMD:CFG does not carry the ignore list');
// getIgnoreJson() builds "ignore" via doc["ignore"].to<JsonArray>(), not the
// doc["key"] = ... pattern the cfgKeys scan above matches, so that check
// never actually covers this field -- assert directly that the app reads it,
// guarded the way an absent-means-unknown key must be (never Array.isArray
// false clearing the list).
if (!/Array\.isArray\(cfg\.ignore\)/.test(appSrc.replace(/\r\n/g, '\n')))
    igFail.push('app does not read cfg.ignore guarded by Array.isArray');
// The ignore gate runs on every above-threshold advert/beacon inside the BLE
// scan callback and the Wi-Fi promiscuous callback -- the two tightest
// stacks in the firmware. sscanf's several-hundred-byte frame has no business
// there (or anywhere else in this file); the MAC parse must be the stdio-free
// one shared with alert_log.cpp's alertLogParseMac().
if (/\bsscanf\s*\(/.test(wwSrc.replace(/\r\n/g, '\n')))
    igFail.push('mode_watchers_watch.cpp uses sscanf -- the ignore MAC parse must be stdio-free (see alertLogParseMac)');
if (igFail.length) { console.log('FAIL: ignore:', igFail); process.exit(1); }
console.log('[signalsweep self-test] ignore list gate + wire: ok');

// ---------------------------------------------------------------------------
// Crash report. The breadcrumb must live in memory a software reset does not
// zero (__NOINIT_ATTR: portable to the C5, unlike RTC_NOINIT_ATTR), be
// believed only after a panic/watchdog reset, and be sanity-checked (a
// half-surviving RAM image must not invent a crash). setup() calls init first.
// (mainSrc and wwSrc are declared above.)
const crFail = [];
let crSrc = '';
try { crSrc = readFileSync(new URL('../firmware/src/crash_report.cpp', import.meta.url), 'utf8'); } catch {}
if (!crSrc) crFail.push('no crash_report.cpp');
if (!/__NOINIT_ATTR/.test(crSrc)) crFail.push('breadcrumb is not __NOINIT_ATTR');
if (!/ESP_RST_PANIC/.test(crSrc) || !/ESP_RST_TASK_WDT/.test(crSrc)) crFail.push('not gated on a panic/watchdog reset');
if (!/CRUMB_MAGIC/.test(crSrc) || !/crumb\.up\s*</.test(crSrc)) crFail.push('breadcrumb not sanity-checked');
if (!/esp_core_dump_get_summary/.test(crSrc)) crFail.push('core dump summary never read');
const setupBody = (mainSrc.match(/void setup\(\) \{[\s\S]*?hardwareInit\(\);/) || [''])[0];
if (!/crashReportInit\(\);/.test(setupBody)) crFail.push('crashReportInit() is not called before hardwareInit() in setup()');
// An RTC-watchdog reset writes no dump: whatever is in the partition is an
// older crash's and must not be presented as this one's. And a missing or
// corrupt image is "no dump", checked before the summary is read.
const crNorm = crSrc.replace(/\r\n/g, '\n');
if (!/if \(r != ESP_RST_WDT && esp_core_dump_image_check\(\) == ESP_OK\) \{[\s\S]*?esp_core_dump_get_summary/.test(crNorm))
    crFail.push('core dump summary is read on ESP_RST_WDT or without esp_core_dump_image_check()');
if (!/crumb\.tgt\s*</.test(crSrc)) crFail.push('breadcrumb target count not sanity-checked');
if (!/crumb\.magic = 0;/.test(crSrc)) crFail.push('init does not clear the breadcrumb magic (an early crash would report up=0 as real)');
const tickFn = (crNorm.match(/void crashBreadcrumbTick\([\s\S]*?\n\}/) || [''])[0];
if (!/crumb\.tgt = targets > 9999 \? 9999 : targets;[\s\S]*crumb\.magic = CRUMB_MAGIC;/.test(tickFn)) crFail.push('tick must set the magic after the fields');
if (!/crumb\.tgt = targets > 9999 \? 9999 : targets;/.test(crSrc)) crFail.push('breadcrumb tgt is not clamped on write (a torn read could push it past the read-side check)');
// CMD:CRASH must exist only inside #ifdef SWEEP_CRASH_TEST blocks, in any
// file that could route a command. Strip those blocks and look for leftovers.
// The lazy match ends at the FIRST #endif, so a nested #if inside such a block
// would end it early (and leave the rest to be flagged) -- keep them flat.
const crashScan = ['main.cpp', 'ble_serial.cpp', 'mode_watchers_watch.cpp', 'crash_report.cpp']
    .map(f => { try { return readFileSync(new URL('../firmware/src/' + f, import.meta.url), 'utf8'); } catch { return ''; } })
    .join('\n').replace(/\r\n/g, '\n')
    .replace(/^[ \t]*#ifdef[ \t]+SWEEP_CRASH_TEST\b[\s\S]*?^[ \t]*#endif\b/gm, '');
if (/CMD:CRASH/.test(crashScan)) crFail.push('CMD:CRASH exists outside #ifdef SWEEP_CRASH_TEST -- it would ship');
const pioIni = readFileSync(new URL('../firmware/platformio.ini', import.meta.url), 'utf8');
if (/SWEEP_CRASH_TEST/.test(pioIni)) crFail.push('platformio.ini sets SWEEP_CRASH_TEST -- the crash hook would ship');
if (!/crashBreadcrumbTick\(/.test(wwSrc)) crFail.push('the 1 Hz task never updates the breadcrumb');
// The C5's one saved frame lands in panic_abort on an abort() (bt.c:562 is one),
// so the panic message is the only thing naming the cause there. IDF 5 only.
if (!/ESP_IDF_VERSION_MAJOR >= 5[\s\S]{0,120}esp_core_dump_get_panic_reason\(last\.reason/.test(crSrc))
    crFail.push('the C5 no longer reads the panic reason from the dump');
if (!/o\["reason"\]/.test(crSrc) || !/c\.reason/.test(appSrc)) crFail.push('the panic reason no longer reaches CMD:CFG and the app line');
if (crFail.length) { console.log('FAIL: crash report:', crFail); process.exit(1); }
console.log('[signalsweep self-test] crash report wiring: ok');

// ---------------------------------------------------------------------------
// Attack-gear rules (Phase 2a). Every rule filed under "Hacking gear" is
// matched only while the Attack toggle is on -- on ALL THREE rule paths:
// the BLE matcher, the Wi-Fi OUI loop and the SSID-prefix pass. One switch,
// one meaning: "tell me about attack tools". Flippers are common hobby gear;
// an always-on beep would cry wolf at every makerspace.
const agFail = [];
if (!/#define HACKING_GEAR_CATEGORY "Hacking gear"/.test(wwSrc)) agFail.push('no HACKING_GEAR_CATEGORY define');
const gateFn = (wwSrc.match(/static inline bool ruleGatedOff\([\s\S]*?\r?\n\}/) || [''])[0];
if (!/!attackDetect/.test(gateFn) || !/HACKING_GEAR_CATEGORY/.test(gateFn)) agFail.push('ruleGatedOff() does not test attackDetect against the category');
const bleMatch = (wwSrc.match(/static int matchDeviceAgainstRule\([\s\S]*?\r?\n\}/) || [''])[0];
if (!/if \(ruleGatedOff\(sig\)\) return 0;/.test(bleMatch)) agFail.push('BLE matcher ignores the Attack toggle');
const ouiLoopAt = wwSrc.indexOf('sig.oui.length() > 0 && sig.ssidPrefix.length() == 0');
if (ouiLoopAt < 0 || !/ruleGatedOff\(sig\)/.test(wwSrc.slice(ouiLoopAt - 300, ouiLoopAt + 200)))
    agFail.push('Wi-Fi OUI loop ignores the Attack toggle');
const ssidAt = wwSrc.indexOf('!foundSsid.startsWith(sig.ssidPrefix)');
if (ssidAt < 0 || !/ruleGatedOff\(sig\)/.test(wwSrc.slice(ssidAt - 300, ssidAt + 200)))
    agFail.push('SSID-prefix pass ignores the Attack toggle');
if (!/matchedCategory = HACKING_GEAR_CATEGORY;/.test(wwSrc)) agFail.push('pwnagotchi detector no longer uses HACKING_GEAR_CATEGORY');
// The category must route to generic (All tab only) -- no routing keyword in it.
for (const kw of ['tag', 'track', 'beacon', 'cam', 'surveil', 'drone', 'uas', 'body', 'axon', 'glasses', 'flock', 'alpr', 'plate', 'shotspotter', 'soundthinking'])
    if ('hacking gear'.includes(kw)) agFail.push(`"Hacking gear" contains the routing keyword "${kw}"`);
if (agFail.length) { console.log('FAIL: attack-gear rules:', agFail); process.exit(1); }
console.log('[signalsweep self-test] attack-gear rules gated by the Attack toggle: ok');

const results = await global.__signalsweepSelfTest();
const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
console.log('[signalsweep self-test]', results);
if (failed.length) {
    console.log('FAIL:', failed.join(', '));
    process.exit(1);
}
console.log('PASS');
process.exit(0);
