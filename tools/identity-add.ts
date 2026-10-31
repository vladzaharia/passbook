// Uploads an identity certificate as a Cloudflare mTLS certificate and adds its binding to wrangler.jsonc.
// Usage: npm run identity:add -- [--name platform] [--cert file] [--key file] [--binding APNS] [--apply]
// Dry run unless --apply. Run `npm run credentials` first; the files stay in .secrets/.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addMtlsBinding,
  parseCertificateId,
  parseIdentityAddArgs,
  uploadArgs,
} from './lib/identity-add.ts';

const root = resolve(import.meta.dirname, '..');
const options = parseIdentityAddArgs(process.argv.slice(2));
const config = resolve(root, 'wrangler.jsonc');

for (const file of [options.cert, options.key]) {
  if (!existsSync(resolve(root, file)))
    throw new Error(`Missing ${file}. Run npm run credentials.`);
}

const args = uploadArgs(options);
console.log(`npx ${args.join(' ')}`);
console.log(`wrangler.jsonc: set mtls_certificates binding ${options.binding}`);
if (!options.apply) {
  console.log('Dry run. Re-run with --apply to upload and edit wrangler.jsonc.');
  process.exit(0);
}

const output = execFileSync('npx', args, { cwd: root, encoding: 'utf8' });
const id = parseCertificateId(output);
writeFileSync(config, addMtlsBinding(readFileSync(config, 'utf8'), options.binding, id));
console.log(`Uploaded ${id}. Bound as ${options.binding}. Run npm run gen, then deploy.`);
