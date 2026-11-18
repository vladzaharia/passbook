import { describe, expect, it } from 'vitest';
import {
  DATA_CLASSES,
  RETENTION_CLASSES,
  type RetentionClass,
} from '../../../shared/privacy/data-classes.ts';
import {
  buildPlan,
  canRelease,
  DAY,
  excludedFromPlatformPass,
  floorChange,
  nextBatch,
  type OrgRow,
  type PlatformPolicy,
  resolveOrg,
  resolvePlatform,
} from './policy.ts';

const NOW = 1_800_000_000_000;
const platform = (cls: RetentionClass = 'scans', d?: unknown, m?: unknown) => {
  const p = resolvePlatform(cls, d, m);
  if (!p.ok) throw new Error('platform invalid');
  return p;
};
const org = (over: Partial<OrgRow> & { orgId: string }): OrgRow => ({
  raw: undefined,
  floor: null,
  held: false,
  ...over,
});

describe('resolvePlatform', () => {
  it('uses the table defaults when nothing is stored', () => {
    for (const cls of RETENTION_CLASSES) {
      const c = DATA_CLASSES[cls];
      expect(resolvePlatform(cls, undefined, undefined)).toEqual({
        ok: true,
        defaultDays: c.platformDefault,
        maxDays: c.platformMax,
      });
    }
  });

  it('clamps the default to the maximum', () => {
    expect(resolvePlatform('scans', 900, 400)).toEqual({
      ok: true,
      defaultDays: 400,
      maxDays: 400,
    });
  });

  it.each([
    ['below the floor', 29],
    ['above the ceiling', 3651],
    ['fractional', 90.5],
    ['a string', '90'],
    ['null', null],
    ['NaN', Number.NaN],
  ])('blocks the class when the stored default is %s', (_name, value) => {
    expect(resolvePlatform('scans', value, undefined)).toEqual({
      ok: false,
      reason: 'platform_invalid',
    });
    expect(resolvePlatform('scans', undefined, value)).toEqual({
      ok: false,
      reason: 'platform_invalid',
    });
  });
});

describe('resolveOrg', () => {
  const p = platform('scans', 396, 1095);
  const base = { cls: 'scans', platform: p, floor: null, held: false, now: NOW } as const;

  it.each([
    ['absent follows the platform default', undefined, 396, 'platform'],
    ['own value', 90, 90, 'org'],
    ['own value at the class floor', 30, 30, 'org'],
    ['own value at the platform max', 1095, 1095, 'org'],
  ] as const)('%s', (_n, orgRaw, days, source) => {
    expect(resolveOrg({ ...base, orgRaw })).toEqual({ kind: 'run', days, source });
  });

  it('clamps an org value above a lowered platform maximum', () => {
    const lowered = platform('scans', 200, 365);
    expect(resolveOrg({ ...base, platform: lowered, orgRaw: 1000 })).toMatchObject({ days: 365 });
  });

  it.each([
    ['below the floor', 29],
    ['above the ceiling', 3651],
    ['fractional', 30.5],
    ['a string', '90'],
    ['null', null],
    ['an object', { days: 90 }],
  ])('an invalid stored value (%s) skips and never falls back to the default', (_n, orgRaw) => {
    expect(resolveOrg({ ...base, orgRaw })).toEqual({ kind: 'skip', reason: 'invalid' });
  });

  it('skips under a hold, even with a valid value', () => {
    expect(resolveOrg({ ...base, orgRaw: 90, held: true })).toEqual({
      kind: 'skip',
      reason: 'hold',
    });
    expect(resolveOrg({ ...base, orgRaw: undefined, held: true })).toEqual({
      kind: 'skip',
      reason: 'hold',
    });
  });

  it('an unexpired floor raises the days', () => {
    const floor = { days: 365, until: NOW + DAY };
    expect(resolveOrg({ ...base, orgRaw: 90, floor })).toEqual({
      kind: 'run',
      days: 365,
      source: 'org',
      pendingShorterFrom: NOW + DAY,
    });
  });

  it('an expired floor, or one at its own boundary, is ignored', () => {
    expect(resolveOrg({ ...base, orgRaw: 90, floor: { days: 365, until: NOW } })).toEqual({
      kind: 'run',
      days: 90,
      source: 'org',
    });
    expect(resolveOrg({ ...base, orgRaw: 90, floor: { days: 365, until: NOW - 1 } })).toMatchObject(
      { days: 90 },
    );
  });

  it('a floor shorter than the configured value changes nothing', () => {
    expect(resolveOrg({ ...base, orgRaw: 200, floor: { days: 100, until: NOW + DAY } })).toEqual({
      kind: 'run',
      days: 200,
      source: 'org',
    });
  });

  it('an invalid value is skipped before a hold or floor is considered', () => {
    expect(
      resolveOrg({ ...base, orgRaw: 1, held: true, floor: { days: 365, until: NOW + DAY } }),
    ).toEqual({
      kind: 'skip',
      reason: 'invalid',
    });
  });

  it('every class honours its own bounds', () => {
    for (const cls of RETENTION_CLASSES) {
      const c = DATA_CLASSES[cls];
      const pol = platform(cls);
      const run = (raw: unknown) =>
        resolveOrg({ cls, platform: pol, orgRaw: raw, floor: null, held: false, now: NOW }).kind;
      expect(run(c.floor)).toBe('run');
      expect(run(c.floor - 1)).toBe('skip');
      expect(run(c.ceiling)).toBe('run');
      expect(run(c.ceiling + 1)).toBe('skip');
    }
  });
});

describe('buildPlan', () => {
  const pol: PlatformPolicy = platform('scans', 396, 1095);

  it('blocks everyone when the platform value is invalid', () => {
    const bad = resolvePlatform('scans', 'x', undefined);
    expect(buildPlan('scans', bad, [org({ orgId: 'a', raw: 90 })], NOW)).toEqual({
      blocked: true,
      cls: 'scans',
      reason: 'platform_invalid',
    });
  });

  it('puts only orgs that differ in special, with their own cutoff', () => {
    const plan = buildPlan(
      'scans',
      pol,
      [org({ orgId: 'b', raw: 90 }), org({ orgId: 'a', raw: 396 }), org({ orgId: 'c', raw: 1000 })],
      NOW,
    );
    if (plan.blocked) throw new Error('blocked');
    expect(plan.platformDays).toBe(396);
    expect(plan.platformCutoff).toBe(NOW - 396 * DAY);
    expect(plan.special).toEqual([
      { orgId: 'b', days: 90, cutoff: NOW - 90 * DAY },
      { orgId: 'c', days: 1000, cutoff: NOW - 1000 * DAY },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('skips held and invalid orgs and excludes them from the platform pass', () => {
    const plan = buildPlan(
      'scans',
      pol,
      [org({ orgId: 'h', held: true }), org({ orgId: 'i', raw: 5 }), org({ orgId: 's', raw: 60 })],
      NOW,
    );
    if (plan.blocked) throw new Error('blocked');
    expect(plan.skipped).toEqual([
      { orgId: 'h', reason: 'hold' },
      { orgId: 'i', reason: 'invalid' },
    ]);
    expect(excludedFromPlatformPass(plan)).toEqual(['h', 'i', 's']);
  });

  it('an org with only a floor that exceeds the default is special', () => {
    const plan = buildPlan(
      'scans',
      pol,
      [org({ orgId: 'f', floor: { days: 800, until: NOW + DAY } })],
      NOW,
    );
    if (plan.blocked) throw new Error('blocked');
    expect(plan.special).toEqual([{ orgId: 'f', days: 800, cutoff: NOW - 800 * DAY }]);
  });

  it('a cutoff is never later than now minus the class floor', () => {
    const plan = buildPlan('scans', platform('scans', 30, 30), [org({ orgId: 'a', raw: 30 })], NOW);
    if (plan.blocked) throw new Error('blocked');
    expect(plan.platformCutoff).toBeLessThanOrEqual(NOW - 30 * DAY);
  });
});

describe('nextBatch', () => {
  const specials = ['d', 'a', 'c', 'b', 'e'].map((orgId) => ({ orgId, days: 90, cutoff: 0 }));
  const ids = (b: { orgId: string }[]) => b.map((o) => o.orgId);

  it('takes the first orgs in id order, then continues after the cursor and wraps', () => {
    const first = nextBatch(specials, null, 2);
    expect(ids(first.batch)).toEqual(['a', 'b']);
    const second = nextBatch(specials, first.cursor, 2);
    expect(ids(second.batch)).toEqual(['c', 'd']);
    const third = nextBatch(specials, second.cursor, 2);
    expect(ids(third.batch)).toEqual(['e', 'a']);
  });

  it('26 special orgs: 25 today, the rest tomorrow', () => {
    const many = Array.from({ length: 26 }, (_, i) => ({
      orgId: `o${String(i).padStart(2, '0')}`,
      days: 90,
      cutoff: 0,
    }));
    const today = nextBatch(many, null);
    expect(today.batch).toHaveLength(25);
    const tomorrow = nextBatch(many, today.cursor);
    expect(ids(tomorrow.batch).slice(0, 2)).toEqual(['o25', 'o00']);
  });

  it('a short list is done in one batch and resets the cursor', () => {
    expect(nextBatch(specials, null, 10)).toMatchObject({ cursor: null });
    expect(nextBatch([], 'x')).toEqual({ batch: [], cursor: null });
  });

  it('a cursor past the last org wraps to the start', () => {
    expect(ids(nextBatch(specials, 'zzz', 2).batch)).toEqual(['a', 'b']);
  });
});

describe('floorChange', () => {
  it.each([
    [365, 90, 'set'],
    [90, 89, 'set'],
    [90, 90, 'clear'],
    [90, 365, 'clear'],
  ] as const)('before %i after %i is %s', (before, after, kind) => {
    expect(floorChange(before, after, NOW).kind).toBe(kind);
  });

  it('keeps the old days for exactly seven days', () => {
    expect(floorChange(365, 90, NOW)).toEqual({ kind: 'set', days: 365, until: NOW + 7 * DAY });
  });
});

describe('canRelease', () => {
  it.each([
    ['org', 'org', true],
    ['org', 'platform', true],
    ['platform', 'platform', true],
    ['platform', 'org', false],
  ] as const)('a %s hold released by %s: %s', (placed, by, ok) => {
    expect(canRelease(placed, by)).toBe(ok);
  });
});
