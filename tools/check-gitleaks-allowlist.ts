// Proves the boundary of .gitleaks.toml with the real binary: every allowed shape is silent, and each case that
// merely contains one (or looks like a secret) is reported. Cases are assembled here at run time, so this file holds
// no secret-shaped text. Usage: node tools/check-gitleaks-allowlist.ts [path-to-gitleaks]  (default: gitleaks)
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
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
const rand = (n: number): string => bytes(n).toString('base64url').slice(0, n);
const hex = (n: number): string => bytes(n).toString('hex').slice(0, n);
const spki = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64');
const pkcs8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64');

/** Each case is a value in the context the key rule reads; `reported` is what the config must do with it. */
const cases: { name: string; value: string; reported: boolean }[] = [
  {
    name: 'demo-key-secret',
    value: `pb_test_k3Qx9Zt2_northwind-demo-key-do-not-use-${hex(12)}`,
    reported: false,
  },
  { name: 'demo-key-prefix', value: 'pb_test_k3Qx9Zt2', reported: false },
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
  { name: 'real-key-with-demo-prefix', value: `pb_test_k3Qx9Zt2_${rand(43)}`, reported: true },
  { name: 'real-key-other-prefix', value: `pb_test_${rand(8)}_${rand(43)}`, reported: true },
  { name: 'rotation-type-with-tail', value: `ApiKeyRotationKey7${rand(24)}`, reported: true },
  { name: 'hex-with-tail', value: `00112233445566778899aabbccddeeff${rand(24)}`, reported: true },
  { name: 'passphrase-slug', value: 'correct-horse-battery-staple-v3', reported: true },
  {
    name: 'public-key-with-junk',
    value: `${spki.replace(/==$/, '')}${rand(30)}==`,
    reported: true,
  },
  { name: 'private-key', value: pkcs8, reported: true },
  { name: 'plain-secret', value: rand(40), reported: true },
];

// gitleaks' own stopwords (demo, example, test...) already ignore a finding that contains one, so a real tail after
// the `whsec_demo_` or `demo-token-` shapes cannot be probed with the binary. For those the pin is structural:
// every allowlist regex must be anchored, which is what makes "contains the shape" not enough.
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
for (const c of cases) writeFileSync(join(cases_dir, `${c.name}.txt`), `api_key = "${c.value}"\n`);

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
