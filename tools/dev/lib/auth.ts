// Per-role sign-in for the visual sweep. Saves Playwright storage state and reuses it while valid.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type APIRequestContext, request } from '@playwright/test';
import { assertLocal, mailFiles, nextMagicToken } from '../../lib/demo-client.ts';
import { emailOf, PORTAL } from '../../lib/demo-data.ts';
import type { Role } from './routes.ts';

const root = resolve(import.meta.dirname, '../../..');
export const MAIL_DIR = resolve(root, '.wrangler/tmp/email');
const TURNSTILE = 'XXXX.DUMMY.TOKEN.XXXX';

export const statePath = (stateDir: string, role: Role) => resolve(stateDir, `${role}.json`);

export const open = (base: string, storageState?: string) =>
  request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin: base },
    ...(storageState ? { storageState } : {}),
  });

export async function signedIn(ctx: APIRequestContext): Promise<boolean> {
  const res = await ctx.get('/api/v1/session');
  return res.ok() && ((await res.json()) as { authenticated?: boolean }).authenticated === true;
}

async function breakglass(ctx: APIRequestContext): Promise<void> {
  const file = resolve(root, '.secrets/breakglass-token');
  const token =
    process.env.SEED_BREAKGLASS_TOKEN ??
    (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
  if (!token) throw new Error('No break-glass token: run npm run breakglass first.');
  const res = await ctx.post('/auth/breakglass', { form: { token }, maxRedirects: 0 });
  if (res.status() !== 302) throw new Error(`Break-glass sign-in failed (${res.status()}).`);
}

/** Polaris ID sign-in through the local mock provider; the console accepts no email link. */
export async function oidc(ctx: APIRequestContext, subject: string): Promise<void> {
  const start = await ctx.get('/auth/oidc/start?next=%2F', { maxRedirects: 0 });
  const toIdp = start.headers().location;
  if (start.status() !== 302 || !toIdp) throw new Error(`OIDC start failed (${start.status()}).`);
  const authorize = new URL(toIdp);
  assertLocal(authorize.origin);
  authorize.searchParams.set('login_hint', subject);
  const idp = await request.newContext();
  const hop = await idp.get(authorize.toString(), { maxRedirects: 0 });
  const back = hop.headers().location;
  await idp.dispose();
  if (hop.status() !== 302 || !back)
    throw new Error(`Mock OIDC refused ${subject} (${hop.status()}). Is npm run dev:oidc running?`);
  const done = await ctx.get(back, { maxRedirects: 0 });
  if (done.status() !== 302) throw new Error(`OIDC sign-in failed (${done.status()}).`);
}

export async function magicLink(
  ctx: APIRequestContext,
  base: string,
  email: string,
): Promise<void> {
  const before = mailFiles(MAIL_DIR);
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.post('/auth/magic/request', {
      data: { email, turnstileToken: TURNSTILE },
    });
    if (res.ok()) break;
    if (res.status() !== 429 || attempt >= 8) {
      throw new Error(
        `Magic link request for ${email} failed (${res.status()}); mail is capped at 5 an hour per address.`,
      );
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
  const token = await nextMagicToken(MAIL_DIR, base, before);
  const res = await ctx.post('/auth/magic/consume', { data: { token } });
  if (!res.ok()) throw new Error(`Magic link for ${email} was refused (${res.status()}).`);
}

const emailFor: Partial<Record<Role, string>> = {
  holder: emailOf(PORTAL[0] as string),
};

/** An authenticated API context for `role`, signing in only when the saved state no longer works. */
export async function contextFor(
  base: string,
  stateDir: string,
  role: Role,
): Promise<APIRequestContext> {
  const file = statePath(stateDir, role);
  // Key and webhook changes ask for a Polaris ID sign-in under 10 minutes old (STEP_UP_SECONDS), so
  // a saved admin session is reused for 5.
  const stale =
    (role === 'org' || role === 'platform') &&
    existsSync(file) &&
    Date.now() - statSync(file).mtimeMs > 300_000;
  if (existsSync(file) && !stale) {
    const saved = await open(base, file);
    if (await signedIn(saved)) return saved;
    await saved.dispose();
  }
  const ctx = await open(base);
  if (role === 'platform') await breakglass(ctx);
  else if (role === 'org') await oidc(ctx, 'demo-owner');
  else await magicLink(ctx, base, emailFor[role] as string);
  if (!(await signedIn(ctx))) throw new Error(`Sign-in as ${role} did not stick.`);
  mkdirSync(dirname(file), { recursive: true });
  await ctx.storageState({ path: file });
  return ctx;
}
