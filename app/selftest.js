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

const results = await global.__signalsweepSelfTest();
const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
console.log('[signalsweep self-test]', results);
if (failed.length) {
    console.log('FAIL:', failed.join(', '));
    process.exit(1);
}
console.log('PASS');
process.exit(0);
