// Adds missing development-only values to .dev.vars. Existing values are never read back or printed.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createFixtureIdentity } from '../src/passkit/testing/fixture-identity.ts';
import { devVarNames, writeDevVars } from './lib/dev-vars.ts';

const file = resolve(import.meta.dirname, '../.dev.vars');
const have = devVarNames(file);
const entries: Record<string, string> = {
  KEK_V1: randomBytes(32).toString('base64'),
  // Cloudflare's always-pass Turnstile test secret.
  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
  // Invisible always-pass test key; the production key only works on its widget's hostnames.
  TURNSTILE_SITE_KEY: '1x00000000000000000000BB',
  // Local mock provider (npm run dev:oidc), not the production issuer.
  OIDC_ISSUER: 'http://localhost:5174',
  OIDC_CLIENT_ID: 'wallet-dev',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  // The scanner document, off in production until M1.
  SCAN_ENABLED: '1',
};

if (!have.has('SIGNER_PLATFORM_CERTIFICATE') || !have.has('SIGNER_PLATFORM_PRIVATE_KEY')) {
  const fixture = await createFixtureIdentity();
  entries.SIGNER_PLATFORM_CERTIFICATE = fixture.certificate;
  entries.SIGNER_PLATFORM_PRIVATE_KEY = fixture.privateKey;
  entries.SIGNER_PLATFORM_INTERMEDIATE = fixture.intermediate;
}

const written = writeDevVars(file, entries);
console.log(written.length ? `.dev.vars: added ${written.join(', ')}` : '.dev.vars: up to date');
