// Proves the boundary of .gitleaks.toml with the real binary: every allowed shape is silent, and each case that
// merely contains one (or looks like a secret) is reported. Cases are assembled here at run time, so this file holds
// no secret-shaped text. Usage: node tools/check-gitleaks-allowlist.ts [path-to-gitleaks]  (default: gitleaks)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bin = process.argv[2] ?? process.env.GITLEAKS_BIN ?? 'gitleaks';
// Pseudo-random but fixed, so a case that is reported once is reported on every run.
let counter = 0;
const bytes = (n: number): Buffer => {
  const out: Buffer[] = [];
  for (let size = 0; size < n; size += 32)
    out.push(createHash('sha256').update(`gitleaks-allowlist-${counter++}`).digest());
  return Buffer.concat(out).subarray(0, n);
};
const sized = (label: string, n: number): Buffer =>
  createHash('sha256').update(label).digest().subarray(0, n);
const rand = (n: number): string => bytes(n).toString('base64url').slice(0, n);
const hex = (n: number): string => bytes(n).toString('hex').slice(0, n);
// P-256 SubjectPublicKeyInfo and PKCS#8 shapes around fixed pseudo-random bytes (the scanner does not check the curve).
const spki = Buffer.concat([
  Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
  Buffer.from([4]),
  bytes(64),
]).toString('base64');
const pkcs8 = Buffer.concat([
  Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex'),
  sized('pk-e', 32),
  Buffer.from('a14403420004', 'hex'),
  bytes(64),
])
  .toString('base64')
  .replace(/[+/]/g, 'A');

/**
 * Each case is a value in the context the key rule reads (`bare`: a header line; `json`: a JSON string right after
 * that escape, as a log line holds it); `reported` is what the config must do with it.
 */
const cases: {
  name: string;
  value: string;
  reported: boolean;
  bare?: boolean;
  json?: 'n' | 'r' | 't';
}[] = [
  {
    name: 'demo-key-secret',
    value: `pb_test_k3Qx9Zt2_northwind-demo-key-do-not-use-${hex(12)}`,
    reported: false,
  },
  { name: 'demo-key-prefix', value: 'pb_test_k3Qx9Zt2', reported: false },
  // A fragment boundary can cut the demo value short; any leading part of its exact shape stays silent.
  {
    name: 'demo-key-cut-name',
    value: 'pb_test_p7Wm4Hn8_northwi',
    reported: false,
  },
  {
    name: 'demo-key-cut-hex',
    value: `pb_test_p7Wm4Hn8_northwind-demo-key-do-not-use-${hex(5)}`,
    reported: false,
  },
  { name: 'demo-key-cut-after-underscore', value: 'pb_test_p7Wm4Hn8_', reported: false },
  // ...but a real tail, a stray tail on the cut, or a long hex run is still reported.
  { name: 'demo-key-cut-real-tail', value: `pb_test_p7Wm4Hn8_northwi${rand(30)}`, reported: true },
  {
    name: 'demo-key-hex-one-too-long',
    value: `pb_test_p7Wm4Hn8_northwind-demo-key-do-not-use-${hex(13)}`,
    reported: true,
  },
  { name: 'demo-webhook', value: `whsec_demo_northwind_${hex(6)}`, reported: false },
  { name: 'demo-token', value: `demo-token-northwind-${hex(22)}`, reported: false },
  { name: 'demo-hex-1', value: '00112233445566778899aabbccddeeff', reported: false },
  { name: 'demo-hex-2', value: 'ffeeddccbbaa99887766554433221100', reported: false },
  { name: 'rotation-type', value: 'ApiKeyRotationKey1', reported: false },
  { name: 'identifier', value: 'p12.privateKeyPem', reported: false },
  { name: 'algorithm', value: 'KEY_ALG_RSA_2048', reported: false },
  { name: 'slug-1', value: 'wallet-completion-v1', reported: false },
  { name: 'slug-2', value: 'incompatible-v2', reported: false },
  { name: 'public-key', value: spki, reported: false },
  {
    name: 'sim-originality-scalar',
    value: `0x${'1d2c3b4a59687786950a1b2c3d4e5f60'}${'718293a4b5c6d7e8f9011223'}n`,
    reported: false,
  },
  { name: 'sim-scalar-with-tail', value: `0x1d2c3b4a5968778695${hex(40)}n`, reported: true },
  { name: 'real-key-with-demo-prefix', value: `pb_test_k3Qx9Zt2_${rand(43)}`, reported: true },
  { name: 'real-key-other-prefix', value: `pb_test_${rand(8)}_${rand(43)}`, reported: true },
  { name: 'rotation-type-with-tail', value: `ApiKeyRotationKey7${rand(24)}`, reported: true },
  { name: 'hex-with-tail', value: `00112233445566778899aabbccddeeff${rand(24)}`, reported: true },
  // Our own key formats are found by custom rules with no stopwords and no `key =` context.
  {
    name: 'key-demo-in-tail',
    value: `pb_test_${rand(8)}_${rand(14)}demo${rand(25)}`,
    reported: true,
  },
  {
    name: 'key-example-in-tail',
    value: `pb_live_${rand(8)}_${rand(14)}example${rand(22)}`,
    reported: true,
  },
  { name: 'live-key-bare', value: `pb_live_${rand(8)}_${rand(43)}`, reported: true, bare: true },
  { name: 'scanner-token-bare', value: `wls_${rand(8)}_${rand(43)}`, reported: true, bare: true },
  { name: 'webhook-bare', value: `whsec_${rand(43)}`, reported: true, bare: true },
  { name: 'webhook-32-char-tail', value: `whsec_${rand(32)}`, reported: false, bare: true },
  {
    name: 'webhook-demo-tail',
    value: `whsec_${rand(10)}demo${rand(29)}`,
    reported: true,
    bare: true,
  },
  {
    name: 'key-ends-with-dash',
    value: `pb_live_${rand(8)}_${rand(42)}-`,
    reported: true,
    bare: true,
  },
  { name: 'try-token', value: `pbtry_${rand(120)}.${rand(43)}`, reported: true, bare: true },
  // A JSON-escaped newline, return or tab is a left boundary: its letter is not part of the token.
  {
    name: 'key-after-json-newline',
    value: `pb_live_${rand(8)}_${rand(43)}`,
    reported: true,
    json: 'n',
  },
  {
    name: 'scanner-token-after-json-tab',
    value: `wls_${rand(8)}_${rand(43)}`,
    reported: true,
    json: 't',
  },
  { name: 'webhook-after-json-newline', value: `whsec_${rand(43)}`, reported: true, json: 'n' },
  { name: 'webhook-after-json-return', value: `whsec_${rand(43)}`, reported: true, json: 'r' },
  {
    name: 'try-token-after-json-newline',
    value: `pbtry_${rand(120)}.${rand(43)}`,
    reported: true,
    json: 'n',
  },
  {
    name: 'demo-key-after-json-newline',
    value: `pb_test_k3Qx9Zt2_northwind-demo-key-do-not-use-${hex(12)}`,
    reported: false,
    json: 'n',
  },
  {
    name: 'demo-webhook-after-json-tab',
    value: `whsec_demo_northwind_${hex(6)}`,
    reported: false,
    json: 't',
  },
  {
    name: 'demo-key-bare',
    value: `pb_test_k3Qx9Zt2_northwind-demo-key-do-not-use-${hex(12)}`,
    reported: false,
    bare: true,
  },
  {
    name: 'demo-webhook-bare',
    value: `whsec_demo_northwind_${hex(6)}`,
    reported: false,
    bare: true,
  },
  { name: 'passphrase-slug', value: 'correct-horse-battery-staple-v3', reported: true },
  {
    name: 'public-key-with-junk',
    value: `${spki.replace(/==$/, '').replace(/[+/]/g, 'A')}${rand(30).replace(/[-_]/g, 'B')}==`,
    reported: true,
  },
  { name: 'private-key', value: pkcs8, reported: true },
  { name: 'plain-secret', value: rand(40), reported: true },
];

// gitleaks' default rules skip a finding that contains a stopword (demo, example...), so the demo-word shapes
// are protected only by the custom passbook-* rules, which have none; the cases above probe those. The pin here
// is structural as well: every allowlist regex must be anchored, so "contains the shape" is not enough.
const unanchored = [
  ...readFileSync(join(root, '.gitleaks.toml'), 'utf8').matchAll(/^\s*'''(.*)''',?\s*$/gm),
]
  .map((m) => m[1] as string)
  .filter((re) => !(re.startsWith('^') && re.endsWith('$')));
if (unanchored.length) {
  for (const re of unanchored)
    console.error(`check-gitleaks-allowlist: ${re} is not anchored with ^...$`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'gitleaks-allowlist-'));
const report = join(dir, 'report.json');
const cases_dir = join(dir, 'cases');
mkdirSync(cases_dir);
const contextOf = (c: (typeof cases)[number]): string =>
  c.json
    ? `{"log":"POST /v1/passes 401\\${c.json}${c.value}\\${c.json}retrying"}\n`
    : c.bare
      ? `Authorization: Bearer ${c.value}\n`
      : `api_key = "${c.value}"\n`;
for (const c of cases) writeFileSync(join(cases_dir, `${c.name}.txt`), contextOf(c));

const run = spawnSync(
  bin,
  [
    'dir',
    cases_dir,
    '--config',
    join(root, '.gitleaks.toml'),
    '--no-banner',
    '--redact',
    '-r',
    report,
    '-f',
    'json',
  ],
  { encoding: 'utf8' },
);
if (run.error) {
  console.error(`check-gitleaks-allowlist: cannot run ${bin}: ${run.error.message}`);
  process.exit(2);
}
const found = new Set(
  (JSON.parse(readFileSync(report, 'utf8')) as { File: string }[]).map((f) =>
    f.File.replace(/^.*\//, '').replace(/\.txt$/, ''),
  ),
);
rmSync(dir, { recursive: true, force: true });

const wrong = cases.filter((c) => found.has(c.name) !== c.reported);
if (wrong.length) {
  for (const c of wrong)
    console.error(
      `check-gitleaks-allowlist: ${c.name} should be ${c.reported ? 'reported' : 'silent'}`,
    );
  process.exit(1);
}
console.log(`check-gitleaks-allowlist: ok (${cases.length} cases)`);
