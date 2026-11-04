// Generates a break-glass admin token. The token goes to .secrets/breakglass-token (0600) and is
// never printed; the Worker only ever holds its SHA-256 (BREAKGLASS_TOKEN_SHA256).
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeDevVars } from './lib/dev-vars.ts';
import { publicBaseUrl } from './lib/site-origin.ts';

const root = resolve(import.meta.dirname, '..');
const secrets = resolve(root, '.secrets');
const tokenFile = resolve(secrets, 'breakglass-token');

if (existsSync(tokenFile) && !process.argv.includes('--rotate')) {
  console.error('.secrets/breakglass-token exists. Pass --rotate to replace it.');
  process.exit(1);
}

const token = `wbg_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(token).digest('hex');

mkdirSync(secrets, { recursive: true, mode: 0o700 });
chmodSync(secrets, 0o700);
writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
chmodSync(tokenFile, 0o600);
writeDevVars(resolve(root, '.dev.vars'), { BREAKGLASS_TOKEN_SHA256: hash }, { replace: true });

console.log(`Token: .secrets/breakglass-token
Local: .dev.vars BREAKGLASS_TOKEN_SHA256 updated
Production: echo ${hash} | npx wrangler secret put BREAKGLASS_TOKEN_SHA256
Sign in: ${publicBaseUrl(resolve(root, 'wrangler.jsonc'))}/auth/breakglass`);
