#!/usr/bin/env node
'use strict';
/**
 * check:nomock - fails when production code or built bundles contain leftover
 * mock/fixture markers. Scope: src/ and dist/ of this extension package.
 * Mock data is allowed in test/ and fixtures/ by design, so those trees are
 * intentionally not scanned.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'dist'];
const SCANNED_EXT = /\.(ts|tsx|js|jsx|css|html|json)$/;
const BANNED = [
  { label: 'SAMPLE_', re: /SAMPLE_/ },
  { label: 'chk_00', re: /chk_00/ },
  { label: 'lorem', re: /\blorem\b/i },
  { label: 'mock', re: /mock/i },
  { label: 'fake', re: /fake/i },
  { label: 'sha256- literal', re: /sha256-[0-9a-f]/i }
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(p);
    } else if (SCANNED_EXT.test(entry.name)) {
      yield p;
    }
  }
}

let failures = 0;
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { label, re } of BANNED) {
      if (re.test(text)) {
        console.error(
          `check:nomock: ${path.relative(ROOT, file)} contains banned marker '${label}'`
        );
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(`check:nomock: ${failures} violation(s)`);
  process.exit(1);
}
console.log('check:nomock: clean');
