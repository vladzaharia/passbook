// Imports a Pass Type ID .p12 into .dev.vars as SIGNER_<NAME>_* without printing secrets.
// Usage: npm run credentials -- /path/to/Pass.p12 [name=platform]
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeDevVars } from './lib/dev-vars.ts';

const root = resolve(import.meta.dirname, '..');
const p12 = process.argv[2];
if (!p12) throw new Error('Usage: npm run credentials -- /path/to/Pass.p12 [name]');
const name = process.argv[3] ?? 'platform';
if (!/^[a-z][a-z0-9-]{0,63}$/.test(name))
  throw new Error('Names use lowercase letters, digits and hyphens.');
const prefix = name.toUpperCase().replaceAll('-', '_');

const openssl = process.env.OPENSSL ?? 'openssl';
const run = (args: string[], input: string) =>
  execFileSync(openssl, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
// The password goes through stdin, never an argument. -legacy reads macOS Keychain exports.
const password = `${process.env.P12_PASSWORD ?? ''}\n`;
const extract = (flags: string[]) =>
  run(['pkcs12', '-legacy', '-in', p12, '-passin', 'stdin', ...flags], password);

const certMatch = extract(['-clcerts', '-nokeys']).match(
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
);
if (!certMatch) throw new Error('No certificate found in the .p12');
const certificate = `${certMatch[0]}\n`;
const privateKey = run(['pkcs8', '-topk8', '-nocrypt'], extract(['-nocerts', '-nodes']));
const intermediate = readFileSync(resolve(root, 'certificates/AppleWWDRCAG4.pem'), 'utf8');

const x = new X509Certificate(certificate);
if (!x.verify(new X509Certificate(intermediate).publicKey))
  throw new Error('WWDR does not verify the pass certificate');
const spki = (key: ReturnType<typeof createPublicKey>) =>
  key.export({ type: 'spki', format: 'der' });
if (!spki(createPublicKey(createPrivateKey(privateKey))).equals(spki(x.publicKey)))
  throw new Error('Certificate and key do not match');
if (new Date(x.validTo) < new Date() || new Date(x.validFrom) > new Date())
  throw new Error('Certificate is not valid now');

mkdirSync(resolve(root, '.secrets'), { recursive: true, mode: 0o700 });
for (const [file, content] of [
  [`.secrets/${name}-certificate.pem`, certificate + intermediate],
  [`.secrets/${name}-key.pem`, privateKey],
] as const) {
  writeFileSync(resolve(root, file), content, { mode: 0o600 });
  chmodSync(resolve(root, file), 0o600);
}
writeDevVars(
  resolve(root, '.dev.vars'),
  { [`SIGNER_${prefix}_CERTIFICATE`]: certificate, [`SIGNER_${prefix}_PRIVATE_KEY`]: privateKey },
  { replace: true },
);
console.log(`Imported ${name}: ${x.subject.replaceAll('\n', '; ')}; expires ${x.validTo}`);
