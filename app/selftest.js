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
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute: noop, style: {}, click: noop, classList: { add: noop, remove: noop } }),
    body: { appendChild: noop, removeChild: noop }
};
global.window = global;

await import('./public/app.js');

const results = await global.__signalsweepSelfTest();
const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
console.log('[signalsweep self-test]', results);
if (failed.length) {
    console.log('FAIL:', failed.join(', '));
    process.exit(1);
}
console.log('PASS');
process.exit(0);
