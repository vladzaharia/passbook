import { describe, expect, it } from 'vitest';
import type { AccessManifest, TemplateManifest } from '../../../passkit/types.ts';
import { checkRows, type RowCheckContext } from './import-check.ts';
import type { ImportPlan } from './import-plan.ts';

const ACCESS: AccessManifest = {
  input: { plan: 'plan', zones: 'zones', from: 'from', until: 'until', visits: 'visits' },
  plans: [
    { id: 'gold', label: 'Gold', kind: 'always', zones: [{ zone: '*' }] },
    { id: 'guest', label: 'Guest', kind: 'guest', zones: [{ zone: '*' }], visits: 2 },
  ],
};

const manifest = (withAccess: boolean) =>
  ({
    schema: 1,
    name: 'T',
    inputs: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', title: 'Name', minLength: 1 },
        points: { type: 'integer', title: 'Points', minimum: 0 },
        tier: { type: 'string', title: 'Tier', enum: ['gold', 'silver'] },
        note: { type: 'string', title: 'Note', maxLength: 5 },
        plan: { type: 'string' },
        zones: { type: 'array', items: { type: 'string' } },
        from: { type: 'string' },
        until: { type: 'string' },
        visits: { type: 'integer' },
      },
    },
    bindings: [],
    display: { title: '{{name}}' },
    ...(withAccess ? { scan: { actions: [], access: ACCESS } } : {}),
  }) as unknown as TemplateManifest;

const HEADER = [
  'Name',
  'Pts',
  'Tier',
  'Note',
  'Email',
  'Id',
  'Plan',
  'Zones',
  'From',
  'Until',
  'Visits',
];
const entry = (from: string) => ({ from: `/${from}` });
const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
  mapping: {
    name: entry('Name'),
    points: entry('Pts'),
    tier: entry('Tier'),
    note: entry('Note'),
    plan: entry('Plan'),
    zones: entry('Zones'),
    from: entry('From'),
    until: entry('Until'),
    visits: entry('Visits'),
  },
  holderEmail: entry('Email'),
  externalId: entry('Id'),
  match: 'externalId',
  keepManual: false,
  save: true,
  ...over,
});
const ctx = (over: Partial<RowCheckContext> = {}): RowCheckContext => ({
  manifest: manifest(false),
  plan: plan(),
  header: HEADER,
  zoneKeys: new Set(['pool']),
  ...over,
});
const cells = (over: Record<string, string> = {}) =>
  HEADER.map((h) => ({ Name: 'Alex', Pts: '3', Email: 'a@x.co', Id: 'A1', ...over })[h] ?? '');
const one = (rows: string[][], c: RowCheckContext = ctx()) =>
  checkRows(
    rows.map((r, i) => ({ row: i + 2, cells: r })),
    c,
  );
const problems = (rows: string[][], c?: RowCheckContext) =>
  one(rows, c).map((r) => r.problems.map((p) => [p.code, p.column, p.message]));

describe('checkRows', () => {
  it('maps, coerces and normalizes a clean row', () => {
    const [r] = one([cells({ Email: ' A@X.co ', Pts: '12', Tier: 'gold' })]);
    expect(r?.problems).toEqual([]);
    expect(r?.input).toEqual({ name: 'Alex', points: 12, tier: 'gold' });
    expect(r?.holderEmail).toBe('a@x.co');
    expect(r?.externalId).toBe('A1');
  });

  it('IMPORT_ROW_SHAPE: a row wider or narrower than the header, before mapping', () => {
    const rows = problems([[...cells(), 'extra'], cells().slice(0, 4)]);
    expect(rows[0]?.[0]?.[0]).toBe('IMPORT_ROW_SHAPE');
    expect(rows[0]?.[0]?.[2]).toBe(
      'The row has 12 cells; the header has 11. Check for a stray delimiter.',
    );
    expect(rows[1]?.[0]?.[2]).toBe(
      'The row has 4 cells; the header has 11. Check for a stray delimiter.',
    );
    expect(one([[...cells(), 'extra']])[0]?.input).toBeNull();
  });

  it('IMPORT_CELL_TOO_LONG names the column', () => {
    expect(problems([cells({ Note: 'x'.repeat(2001) })])[0]).toEqual([
      ['IMPORT_CELL_TOO_LONG', 'Note', 'Note is longer than 2000 characters. Shorten it.'],
    ]);
  });

  it('words template input failures as one sentence each, with the column', () => {
    const got = problems([
      cells({ Pts: '1.5', Tier: 'bronze', Note: 'too long', Id: 'r1' }),
      cells({ Pts: '-1', Id: 'r2' }),
      cells({ Name: '', Id: 'r3' }),
    ]);
    expect(got[0]).toEqual(
      expect.arrayContaining([
        ['INPUT', 'Pts', 'Points must be a whole number.'],
        ['INPUT', 'Tier', 'Tier must be one of: gold, silver.'],
        ['INPUT', 'Note', 'Note must have at most 5 characters.'],
      ]),
    );
    expect(got[1]).toEqual([['INPUT', 'Pts', 'Points must be at least 0.']]);
    expect(got[2]).toEqual([['INPUT', 'Name', 'Name is required.']]);
  });

  it('EMAIL_INVALID names the column; a blank email is fine unless it is the key', () => {
    expect(problems([cells({ Email: 'nope' })])[0]).toEqual([
      ['EMAIL_INVALID', 'Email', 'Email is not valid.'],
    ]);
    expect(problems([cells({ Email: '' })])[0]).toEqual([]);
  });

  it('IMPORT_KEY_MISSING for an empty External ID or Email when it is the key', () => {
    expect(problems([cells({ Id: '' })])[0]).toEqual([
      ['IMPORT_KEY_MISSING', 'Id', 'External ID is empty. Fill it in.'],
    ]);
    expect(problems([cells({ Email: '' })], ctx({ plan: plan({ match: 'email' }) }))[0]).toEqual([
      ['IMPORT_KEY_MISSING', 'Email', 'Email is empty. Fill it in.'],
    ]);
    expect(
      problems([cells({ Id: '', Email: '' })], ctx({ plan: plan({ match: 'none' }) }))[0],
    ).toEqual([]);
  });

  it('IMPORT_DUPLICATE_KEY points at the first row, without the email', () => {
    const got = problems([cells({ Id: 'A12' }), cells({ Id: 'B1' }), cells({ Id: 'A12' })]);
    expect(got[2]).toEqual([['IMPORT_DUPLICATE_KEY', 'Id', 'External ID A12 is also on row 2.']]);
    const byEmail = problems(
      [cells({ Email: 'a@x.co' }), cells({ Email: 'A@X.co' })],
      ctx({ plan: plan({ match: 'email' }) }),
    );
    expect(byEmail[1]).toEqual([['IMPORT_DUPLICATE_KEY', 'Email', 'Email is also on row 2.']]);
  });

  it('does not look at keys when there is no matching', () => {
    const got = problems([cells(), cells()], ctx({ plan: plan({ match: 'none' }) }));
    expect(got).toEqual([[], []]);
  });

  describe('a template with scan.access', () => {
    const access = (over: Record<string, string>) =>
      problems([cells(over)], ctx({ manifest: manifest(true) }))[0];

    it('accepts a plan, live zones and a window', () => {
      expect(
        access({
          Plan: 'gold',
          Zones: 'pool',
          From: '2026-06-01T00:00:00Z',
          Until: '2026-06-02T00:00:00Z',
        }),
      ).toEqual([]);
    });

    it.each([
      [{ Plan: 'platinum' }, 'ACCESS_PLAN_UNKNOWN', 'Plan'],
      [{ Plan: 'gold', Zones: 'pool;sauna' }, 'ACCESS_ZONE_UNKNOWN', 'Zones'],
      [
        { Plan: 'gold', From: '2026-06-02T00:00:00Z', Until: '2026-06-01T00:00:00Z' },
        'ACCESS_WINDOW',
        'Until',
      ],
      [{ Plan: 'guest', Visits: '1000' }, 'ACCESS_GUEST_RANGE', 'Visits'],
      [{ Plan: 'gold', Visits: '2' }, 'ACCESS_VISITS', 'Visits'],
    ])('%j gives %s on column %s', (over, code, column) => {
      const got = access(over);
      expect(got?.map((p) => [p[0], p[1]])).toEqual([[code, column]]);
    });
  });
});
