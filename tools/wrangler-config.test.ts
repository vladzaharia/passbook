import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readJsonc } from './lib/jsonc.ts';

interface Wrangler {
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
    // npm run gen, so a fresh checkout may not have it yet.
    expect(new Set(patterns)).toEqual(new Set(['/*', '!/index.html', '!/templates/*', ...shipped]));
  });
});
