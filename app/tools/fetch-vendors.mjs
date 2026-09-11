// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
//
// Refreshes the two vendor lists the app looks names up in:
//   public/oui.txt         AABBCC<TAB>vendor   (IEEE MA-L registry)
//   public/bt-company.txt  id<TAB>company      (Bluetooth SIG company IDs)
// Run by hand (`node tools/fetch-vendors.mjs` from app/) and commit the output.
// The lists are bundled on purpose: an online lookup would hand every MAC the
// device hears to a third party.
import { writeFileSync } from 'node:fs';

const OUI_URL = 'https://standards-oui.ieee.org/oui/oui.csv';
const BT_URL  = 'https://bitbucket.org/bluetooth-SIG/public/raw/main/assigned_numbers/company_identifiers/company_identifiers.yaml';

// Legal-form noise that only costs bytes and row width.
function tidy(name) {
    return name.replace(/\s*\([^)]*\)?/g, '').replace(/\s+/g, ' ')
        .replace(/[,.]?\s*\b(inc|incorporated|corp|corporation|co|ltd|limited|llc|gmbh|ag|s\.?a|b\.?v|oy|ab|plc|pty|pte|srl|kg|company)\b\.?/gi, '')
        .replace(/[\s,.]+$/, '').trim().slice(0, 28);
}

async function get(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'SignalSweep vendor refresh' } });
    if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
    return r.text();
}

// IEEE CSV: Registry,Assignment,Organization Name,Organization Address
const csv = await get(OUI_URL);
const oui = new Map();
for (const line of csv.split(/\r?\n/).slice(1)) {
    const m = line.match(/^MA-L,([0-9A-F]{6}),(?:"((?:[^"]|"")*)"|([^,]*)),/);
    if (m) oui.set(m[1], tidy((m[2] ?? m[3]).replace(/""/g, '"')));
}
if (oui.size < 20000) throw new Error('OUI list suspiciously short: ' + oui.size);
writeFileSync(new URL('../public/oui.txt', import.meta.url),
    [...oui].sort().map(([k, v]) => k + '\t' + v).join('\n') + '\n');

// SIG YAML: "  - value: 0x004C\n    name: 'Apple, Inc.'"
const yaml = await get(BT_URL);
const bt = [...yaml.matchAll(/value:\s*0x([0-9A-Fa-f]+)\s*\n\s*name:\s*(['"])(.*?)\2\s*$/gm)]
    .map(m => [parseInt(m[1], 16), tidy(m[3].replace(/''/g, "'"))]);
if (bt.length < 1000) throw new Error('BT company list suspiciously short: ' + bt.length);
bt.sort((a, b) => a[0] - b[0]);
writeFileSync(new URL('../public/bt-company.txt', import.meta.url),
    bt.map(([k, v]) => k + '\t' + v).join('\n') + '\n');

console.log('oui.txt: ' + oui.size + ' prefixes, bt-company.txt: ' + bt.length + ' companies');
