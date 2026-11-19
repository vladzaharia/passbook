import { describe, expect, it } from 'vitest';
import type { PassJson } from '../types.ts';
import { accessIssues } from './access/index.ts';
import { loadBaked } from './baked-fixtures.ts';
import { ScanDisplayDocSchema } from './scan-display/schema.ts';
import { scanDisplayIssues } from './scan-display/validate.ts';

const SLUGS = ['starter-monthly-pass', 'starter-day-pass', 'starter-guest-pass'] as const;

describe.each(SLUGS)('%s', (slug) => {
  it('is a blueprint with wallets and a valid access plan and display', async () => {
    const { template } = await loadBaked(slug, { strips: false });
    const m = template.manifest;
    expect(m.blueprint).toBe(true);
    expect(m.wallets).toEqual({ schema: 1, google: {}, samsung: {} });
    expect(accessIssues(m)).toEqual([]);
    expect(() => ScanDisplayDocSchema.parse(m.scan?.display)).not.toThrow();
    const issues = scanDisplayIssues(m, { passJson: template.passJson as PassJson });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('entry pass types', () => {
  const plans = async (slug: string) =>
    ((await loadBaked(slug, { strips: false })).template.manifest.scan?.access?.plans ?? []).map(
      (p) => ({ ...p }),
    );

  it('the access card carries Guest in too', async () => {
    const { template } = await loadBaked('starter-access-card', { strips: false });
    expect(template.manifest.scan?.actions?.map((a) => a.id)).toEqual(['enter', 'guest_in']);
  });

  it('Monthly is always-on with Guest in taking from guests', async () => {
    const { template } = await loadBaked('starter-monthly-pass', { strips: false });
    expect((await plans('starter-monthly-pass')).map((p) => [p.id, p.kind])).toEqual([
      ['member', 'always'],
    ]);
    const [enter, guestIn] = template.manifest.scan?.actions ?? [];
    expect(enter).toMatchObject({ kind: 'check_in', repeat: 'daily' });
    expect(guestIn).toMatchObject({
      id: 'guest_in',
      label: 'Guest in',
      kind: 'take',
      input: 'guests',
    });
  });

  it('Day pass is check-in only: one day from the first scan, unlimited entries', async () => {
    const { template } = await loadBaked('starter-day-pass', { strips: false });
    expect(template.manifest.scan?.access).toBeUndefined();
    expect(template.manifest.scan?.checkIn).toEqual({
      mode: 'unlimited',
      days: 1,
      durationFrom: 'first_scan',
    });
  });

  it('Guest pass is one day, one visit', async () => {
    const [plan] = await plans('starter-guest-pass');
    expect(plan).toMatchObject({ id: 'guest', kind: 'guest', days: 1, visits: 1 });
  });
});
