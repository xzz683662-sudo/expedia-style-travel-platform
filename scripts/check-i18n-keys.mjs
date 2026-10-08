import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Fails when the UI references a translation key that does not exist.
 *
 * Why this exists: `translate()` deliberately falls back to returning the key
 * itself rather than `undefined`, so a missing key renders as literal text like
 * `nav.signIn` on the page — visible, but easy to miss in review and invisible
 * to `tsc`, because the key is an opaque string at the call site. That is
 * exactly how a `t('nav.signIn')` shipped; the real key is `common.signIn`.
 *
 * It also asserts the two dictionaries have identical key sets, which is the
 * other half of the same failure: a key added to `en` but not `zh` silently
 * renders English to a Chinese reader.
 *
 *   node scripts/check-i18n-keys.mjs
 */

const ROOT = resolve(import.meta.dirname, '..');
const WEB_SRC = resolve(ROOT, 'apps/web/src');
const DICTIONARY = resolve(WEB_SRC, 'lib/i18n/dictionaries.ts');

/** Collects dotted key paths from a dictionary object literal. */
function collectKeys(source, objectName) {
  const start = source.indexOf(`const ${objectName} = {`);
  if (start === -1) throw new Error(`${objectName} dictionary not found`);
  // Walk braces to find the end of the object literal.
  let depth = 0;
  let began = false;
  let end = start;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') {
      depth += 1;
      began = true;
    } else if (char === '}') {
      depth -= 1;
      if (began && depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(start, end);

  // Track the nesting of object literals; a `key:` at depth 1 inside a section
  // becomes `section.key`, and function values are still keys.
  const keys = new Set();
  const stack = [];
  const lines = body.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    const shorthand = line.match(/^([A-Za-z_$][\w$]*)\s*:\s*\{/);
    const scalar = line.match(/^([A-Za-z_$][\w$]*)\s*:/);

    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    if (shorthand) {
      stack.push(shorthand[1]);
    } else if (scalar) {
      keys.add([...stack, scalar[1]].join('.'));
    }

    // Adjust depth after recording, so a section name is a path segment and not
    // a leaf key.
    const netDepth = opens - closes;
    if (!shorthand && netDepth < 0) {
      for (let i = 0; i < -netDepth; i += 1) stack.pop();
    }
    if (shorthand && netDepth <= 0) {
      // `section: { ... }` closed on one line — pop the name we just pushed.
      for (let i = 0; i < -netDepth + 1; i += 1) stack.pop();
    }
  }
  return keys;
}

const dictionarySource = readFileSync(DICTIONARY, 'utf8');
const en = collectKeys(dictionarySource, 'en');
const zh = collectKeys(dictionarySource, 'zh');

let failures = 0;

// --- 1. en and zh must agree -------------------------------------------------
const missingInZh = [...en].filter((key) => !zh.has(key));
const missingInEn = [...zh].filter((key) => !en.has(key));
if (missingInZh.length || missingInEn.length) {
  failures += missingInZh.length + missingInEn.length;
  console.log('\x1b[31m✗\x1b[0m en/zh key sets differ');
  for (const key of missingInZh) console.log(`    missing in zh: ${key}`);
  for (const key of missingInEn) console.log(`    missing in en: ${key}`);
} else {
  console.log(`\x1b[32m✓\x1b[0m en and zh agree — ${en.size} keys`);
}

// --- 2. every literal key used in the UI must exist --------------------------
const files = [
  ...globSync('app/**/*.tsx', { cwd: WEB_SRC }),
  ...globSync('components/**/*.tsx', { cwd: WEB_SRC }),
];

const USAGE = /\bt\(\s*'([a-zA-Z0-9_.]+)'/g;
const unknown = new Map();

for (const relative of files) {
  const text = readFileSync(resolve(WEB_SRC, relative), 'utf8');
  for (const match of text.matchAll(USAGE)) {
    const key = match[1];
    if (!en.has(key)) {
      if (!unknown.has(key)) unknown.set(key, new Set());
      unknown.get(key).add(relative);
    }
  }
}

if (unknown.size > 0) {
  failures += unknown.size;
  console.log(`\x1b[31m✗\x1b[0m ${unknown.size} unknown key(s) referenced`);
  for (const [key, where] of [...unknown].sort()) {
    console.log(`    ${key}  ← ${[...where].join(', ')}`);
  }
} else {
  console.log(`\x1b[32m✓\x1b[0m every key referenced in the UI exists`);
}

console.log(
  `\n${failures === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m — ${en.size} keys, ${files.length} files scanned`,
);
process.exitCode = failures === 0 ? 0 : 1;
