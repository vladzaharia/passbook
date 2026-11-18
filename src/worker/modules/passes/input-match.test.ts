import { describe, expect, it } from 'vitest';
import type { InputMatch } from '../../../shared/contracts/broadcasts.ts';
import { startOfDay } from '../../../shared/zoned.ts';
import { all, run } from '../../platform/db.ts';
import { targetFilter } from '../broadcasts/apply.ts';
import { countTarget, targetPage } from '../broadcasts/repo-target.ts';
import { broadcastKit } from '../broadcasts/test-kit.ts';
import { eventMatchSql } from '../scan/repo-event-match.ts';
import { listPasses } from './repo-list.ts';

type Fixture = Record<string, string>;
async function seed(personalizations: Record<string, string>) {
  const kit = await broadcastKit();
  const ids: Record<string, string> = {};
  for (const [name, json] of Object.entries(personalizations)) {
    const pass = await kit.makePass();
    await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [json, pass.id]);
    ids[name] = pass.id;
  }
  const names = (page: string[]) =>
    Object.entries(ids)
      .filter(([, id]) => page.includes(id))
      .map(([n]) => n)
      .sort();
  const match = async (m: InputMatch) => {
    const f = targetFilter(
      {
        org_id: kit.org.id,
        mode: 'live',
        target: JSON.stringify({ templateIds: [kit.messaging.id], match: m }),
      },
      null,
      100,
    );
    const now = kit.clock.now();
    const page = names((await targetPage(kit.env.DB, f, now)).ids);
    const counts = await countTarget(kit.env.DB, f, now, now - 86_400_000, 3);
    expect(counts.targeted).toBe(page.length);
    const listed = await listPasses(kit.env.DB, {
      orgId: kit.org.id,
      mode: 'live',
      match: m,
      limit: 100,
    });
    expect(names(listed.items.map((p) => p.id))).toEqual(page);
    return page;
  };
  return { kit, ids, match };
}

describe('input match: values', () => {
  const fixture: Fixture = {
    text: '{"k":"Sat"}',
    int: '{"k":3}',
    real: '{"k":2.5}',
    yes: '{"k":true}',
    no: '{"k":false}',
    other: '{"k":"Sun"}',
    missing: '{"x":"Sat"}',
    array: '["Sat"]',
    str: '"Sat"',
    nested: '{"k":{"a":"Sat"}}',
    upper: '{"k":"sat"}',
  };
  it('matches like a scan event: types, case, missing keys, non-objects', async () => {
    const { match } = await seed(fixture);
    expect(await match([{ input: 'k', values: ['Sat'] }])).toEqual(['text']);
    expect(await match([{ input: 'k', values: ['3', '2.5'] }])).toEqual(['int', 'real']);
    expect(await match([{ input: 'k', values: ['1'] }])).toEqual(['yes']);
    expect(await match([{ input: 'k', values: ['0'] }])).toEqual(['no']);
    expect(await match([{ input: 'k', values: ['Sat', 'Sun'] }])).toEqual(['other', 'text']);
    expect(await match([{ input: 'nope', values: ['Sat'] }])).toEqual([]);
  });

  it('gives the same pass set as eventMatchSql, with 20 values and a 120-char value', async () => {
    const long = 'x'.repeat(120);
    const { kit, match } = await seed({ ...fixture, long: `{"k":"${long}"}` });
    const sets: string[][] = [
      ['Sat'],
      ['3', '2.5', '1', '0'],
      [long],
      Array.from({ length: 19 }, (_, i) => `v${i}`).concat('Sat'),
    ];
    for (const values of sets) {
      const rows = await all<{ id: string }>(
        kit.env.DB,
        `SELECT p.id FROM passes p JOIN (SELECT ? AS match_input, ? AS match_values) e
         WHERE p.org_id = ? AND ${eventMatchSql('e', 'p')} ORDER BY p.id DESC`,
        ['k', JSON.stringify(values), kit.org.id],
      );
      const viaTarget = await match([{ input: 'k', values }]);
      expect(viaTarget.length).toBe(rows.length);
    }
  });

  it('matches an input key with . " or $ literally', async () => {
    const { match } = await seed({
      dot: '{"a.b":"x"}',
      nested: '{"a":{"b":"x"}}',
      quote: '{"a\\"b":"x"}',
      dollar: '{"$.a":"x"}',
    });
    expect(await match([{ input: 'a.b', values: ['x'] }])).toEqual(['dot']);
    expect(await match([{ input: 'a"b', values: ['x'] }])).toEqual(['quote']);
    expect(await match([{ input: '$.a', values: ['x'] }])).toEqual(['dollar']);
    expect(await match([{ input: "a' OR 1=1 --", values: ['x'] }])).toEqual([]);
  });
});

describe('input match: number and date ranges', () => {
  it('number range is inclusive', async () => {
    const { match } = await seed({
      low: '{"n":1}',
      mid: '{"n":5.5}',
      high: '{"n":10}',
      text: '{"n":"7"}',
      none: '{"n":null}',
      bool: '{"n":true}',
    });
    expect(await match([{ input: 'n', min: 5.5, max: 10 }])).toEqual(['high', 'mid', 'text']);
    expect(await match([{ input: 'n', min: 2 }])).toEqual(['high', 'mid', 'text']);
    expect(await match([{ input: 'n', max: 1 }])).toEqual(['low']);
  });

  it('date range: date-only by text, date-time by zone, inclusive ends', async () => {
    const { match } = await seed({
      a: '{"d":"2026-06-10"}',
      b: '{"d":"2026-06-15"}',
      c: '{"d":"2026-06-20"}',
      // 23:30 UTC on the 14th is already the 15th in Berlin.
      late: '{"d":"2026-06-14T23:30:00Z"}',
      offset: '{"d":"2026-06-20T23:30:00-05:00"}',
      junk: '{"d":"soon"}',
      num: '{"d":20260615}',
    });
    const berlin = 'Europe/Berlin';
    expect(
      await match([{ input: 'd', from: '2026-06-15', to: '2026-06-20', timeZone: berlin }]),
    ).toEqual(['b', 'c', 'late']);
    expect(
      await match([{ input: 'd', from: '2026-06-15', to: '2026-06-15', timeZone: berlin }]),
    ).toEqual(['b', 'late']);
    expect(
      await match([{ input: 'd', from: '2026-06-15', to: '2026-06-15', timeZone: 'UTC' }]),
    ).toEqual(['b']);
    expect(await match([{ input: 'd', to: '2026-06-10', timeZone: berlin }])).toEqual(['a']);
    expect(await match([{ input: 'd', from: '2026-06-21', timeZone: berlin }])).toEqual(['offset']);
  });

  it('date clauses ignore text that only looks date-sized', async () => {
    const { match } = await seed({
      real: '{"d":"2026-06-15"}',
      name: '{"d":"John Smith"}',
      code: '{"d":"ABCD-12345"}',
      julian: '{"d":"2460000.50"}',
      stamp: '{"d":"2026-06-15T10:00:00Z"}',
    });
    const zone = 'UTC';
    expect(await match([{ input: 'd', from: '2026-01-01', timeZone: zone }])).toEqual([
      'real',
      'stamp',
    ]);
    expect(await match([{ input: 'd', to: '2999-01-01', timeZone: zone }])).toEqual([
      'real',
      'stamp',
    ]);
  });

  it('number range also reads numeric text such as "42"', async () => {
    const { match } = await seed({
      text: '{"n":"42"}',
      neg: '{"n":"-1.5"}',
      word: '{"n":"42 apples"}',
      dash: '{"n":"4-2"}',
      empty: '{"n":""}',
      num: '{"n":40}',
    });
    expect(await match([{ input: 'n', min: 41, max: 43 }])).toEqual(['text']);
    expect(await match([{ input: 'n', max: 0 }])).toEqual(['neg']);
    expect(await match([{ input: 'n', min: 40 }])).toEqual(['num', 'text']);
  });

  it('bounds the date-time range at the zone day start', () => {
    expect(startOfDay('2026-06-15', 'Europe/Berlin')).toBe(Date.UTC(2026, 5, 14, 22, 0));
  });
});

describe('input match: clauses are ANDed', () => {
  it('needs every clause', async () => {
    const { match } = await seed({
      both: '{"s":"FL1430","n":4}',
      one: '{"s":"FL1430","n":1}',
      bad: 'null',
    });
    expect(
      await match([
        { input: 's', values: ['FL1430'] },
        { input: 'n', min: 2 },
      ]),
    ).toEqual(['both']);
  });
});
