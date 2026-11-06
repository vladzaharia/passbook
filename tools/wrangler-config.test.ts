import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readJsonc } from './lib/jsonc.ts';

interface Wrangler {
  vars?: Record<string, string>;
  routes?: { pattern: string; custom_domain?: boolean }[];
  send_email?: { name: string; allowed_sender_addresses?: string[] }[];
  triggers?: { crons?: string[] };
  analytics?: { binding: string };
  analytics_engine_datasets?: { binding: string; dataset: string }[];
  assets?: { run_worker_first?: string[] };
}

const wrangler = readJsonc<Wrangler>(new URL('../wrangler.jsonc', import.meta.url).pathname);
const cronSource = readFileSync(new URL('../src/worker/jobs/cron.ts', import.meta.url), 'utf8');
const constant = (name: string) =>
  new RegExp(`export const ${name} = '([^']+)'`).exec(cronSource)?.[1];

describe('wrangler.jsonc', () => {
  it('schedules exactly the cron expressions the dispatcher has hooks for', () => {
    expect([...(wrangler.triggers?.crons ?? [])].sort()).toEqual(
      [constant('MINUTE_CRON'), constant('DAILY_CRON')].sort(),
    );
  });

  it('binds the Analytics SQL reader next to the event writer', () => {
    expect(wrangler.analytics?.binding).toBe('ANALYTICS_SQL');
    expect(wrangler.analytics_engine_datasets).toContainEqual({
      binding: 'EVENTS',
      dataset: 'wallet_events',
    });
  });

  it('runs the Worker first for everything except the files public/ ships', () => {
    const patterns = wrangler.assets?.run_worker_first ?? [];
    const shipped = readdirSync(new URL('../public', import.meta.url), { withFileTypes: true })
      .filter((entry) => !/^[._]/.test(entry.name))
      .map((entry) => (entry.isDirectory() ? `!/${entry.name}/*` : `!/${entry.name}`));
    expect(shipped.length).toBeGreaterThan(5);
    // index.html stays a static asset (it redirects to /). public/templates comes from
    // npm run gen, so a fresh checkout may not have it yet. scan.webmanifest goes through the
    // Worker's scan gate.
    expect(shipped).toContain('!/scan.webmanifest');
    const served = shipped.filter((p) => p !== '!/scan.webmanifest');
    expect(new Set(patterns)).toEqual(new Set(['/*', '!/index.html', '!/templates/*', ...served]));
  });

  it('keeps the scanner off in production until M1', () => {
    expect(wrangler.vars?.SCAN_ENABLED).toBe('1');
  });

  it('attaches the canonical host and each redirect host as custom domains', () => {
    const vars = wrangler.vars ?? {};
    const canonical = new URL(vars.PUBLIC_BASE_URL ?? '').host;
    const redirects = (vars.REDIRECT_HOSTS ?? '').split(',').filter(Boolean);
    expect(redirects.length).toBeGreaterThan(0);
    expect(wrangler.routes).toEqual(
      [canonical, ...redirects].map((pattern) => ({ pattern, custom_domain: true })),
    );
    expect(vars.OIDC_CLIENT_ID).toBe(`${vars.PUBLIC_BASE_URL}/auth/oidc/client-metadata.json`);
  });

  it('sends from an address the email binding allows', () => {
    const binding = wrangler.send_email?.find((b) => b.name === 'EMAIL');
    expect(binding?.allowed_sender_addresses).toEqual([wrangler.vars?.EMAIL_FROM]);
  });
});
