import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../types.ts';
import { accessIssues } from './validate.ts';

const inputs = {
  type: 'object',
  properties: {
    plan: { type: 'string', default: 'gold' },
    zones: { type: 'array', items: { type: 'string' } },
    home: { type: 'string' },
    from: { type: 'string', format: 'date-time' },
    until: { type: 'string', format: 'date-time' },
    visits: { type: 'integer' },
    sponsor: { type: 'string' },
    status: { type: 'string' },
  },
};
const GOOD = {
  input: {
    plan: 'plan',
    zones: 'zones',
    from: 'from',
    until: 'until',
    visits: 'visits',
    sponsor: 'sponsor',
  },
  plans: [
    { id: 'gold', label: '24/7 Gold', kind: 'always', zones: [{ zone: '*' }] },
    {
      id: 'offpeak',
      label: 'Off-peak',
      kind: 'timed',
      hours: { mon: ['06:00-10:00', '20:00-02:00'], tue: ['06:00-10:00'] },
      zones: [
        { zone: 'capitol-hill' },
        { zone: 'pool', hours: { mon: ['06:00-10:00'] } },
        { zone: { input: 'home' } },
      ],
    },
    { id: 'guest', label: 'Guest', kind: 'guest', visits: 2, days: 1, zones: [{ zone: '*' }] },
  ],
  suspend: { input: 'status', equals: ['Suspended'] },
  rules: { visitGapMinutes: 120, reentryMinutes: null },
};
const manifest = (
  access: unknown,
  actions: unknown = [{ id: 'check_in', label: 'In', kind: 'check_in' }],
) =>
  ({
    schema: 1,
    name: 'T',
    inputs,
    sample: {},
    bindings: [],
    scan: { actions, access },
  }) as unknown as TemplateManifest;
const codes = (access: unknown, actions?: unknown, zones?: string[]) =>
  accessIssues(manifest(access, actions), { zones }).map((i) => i.code);
const edit = (fn: (a: typeof GOOD) => void) => {
  const copy = structuredClone(GOOD);
  fn(copy);
  return copy;
};

describe('accessIssues', () => {
  it('passes a sound manifest and a manifest without access', () => {
    expect(codes(GOOD)).toEqual([]);
    expect(
      accessIssues({
        schema: 1,
        name: 'T',
        inputs,
        sample: {},
        bindings: [],
      } as unknown as TemplateManifest),
    ).toEqual([]);
  });
  it('ACCESS_SHAPE', () => {
    expect(codes('x')).toContain('ACCESS_SHAPE');
    expect(codes({ ...GOOD, extra: 1 })).toContain('ACCESS_SHAPE');
    expect(codes({ ...GOOD, plans: [] })).toContain('ACCESS_SHAPE');
    expect(codes(edit((a) => Object.assign(a.plans[0] as object, { colour: 'red' })))).toContain(
      'ACCESS_SHAPE',
    );
    expect(codes(edit((a) => Object.assign(a.plans[0] as object, { kind: 'vip' })))).toContain(
      'ACCESS_SHAPE',
    );
    expect(codes(edit((a) => Object.assign(a.input, { extra: 'x' })))).toContain('ACCESS_SHAPE');
    expect(
      codes(
        edit((a) =>
          Object.assign((a.plans[1] as { hours: object }).hours, { noday: ['06:00-07:00'] }),
        ),
      ),
    ).toContain('ACCESS_SHAPE');
    expect(
      codes({
        ...GOOD,
        plans: Array.from({ length: 13 }, (_, i) => ({
          ...GOOD.plans[0],
          id: `p${i}`,
          label: `P${i}`,
        })),
      }),
    ).toContain('ACCESS_SHAPE');
  });
  it('ACCESS_NO_CHECK_IN', () => {
    expect(codes(GOOD, [{ id: 'add', label: 'Add', kind: 'add', input: 'visits' }])).toContain(
      'ACCESS_NO_CHECK_IN',
    );
    expect(codes(GOOD, [])).toContain('ACCESS_NO_CHECK_IN');
  });
  it('plan id, duplicate and label', () => {
    expect(
      codes(
        edit((a) => {
          (a.plans[0] as { id: string }).id = 'Gold';
        }),
      ),
    ).toContain('ACCESS_PLAN_ID');
    expect(
      codes(
        edit((a) => {
          (a.plans[1] as { id: string }).id = 'gold';
        }),
      ),
    ).toContain('ACCESS_PLAN_DUPLICATE');
    expect(
      codes(
        edit((a) => {
          (a.plans[0] as { label: string }).label = '';
        }),
      ),
    ).toContain('ACCESS_PLAN_LABEL');
    expect(
      codes(
        edit((a) => {
          (a.plans[0] as { label: string }).label = 'x'.repeat(25);
        }),
      ),
    ).toContain('ACCESS_PLAN_LABEL');
    expect(
      codes(
        edit((a) => {
          (a.plans[1] as { label: string }).label = '24/7 gold';
        }),
      ),
    ).toContain('ACCESS_PLAN_LABEL');
  });
  it('ACCESS_PLAN_DEFAULT', () => {
    expect(
      codes(
        edit((a) => {
          (a.plans[0] as { id: string }).id = 'silver';
        }),
      ),
    ).toContain('ACCESS_PLAN_DEFAULT');
  });
  it('ACCESS_INPUT', () => {
    for (const patch of [
      { plan: 'visits' },
      { plan: 'missing' },
      { zones: 'visits' },
      { from: 'status' },
      { until: 'visits' },
      { visits: 'status' },
      { sponsor: 'visits' },
    ])
      expect(codes(edit((a) => Object.assign(a.input, patch)))).toContain('ACCESS_INPUT');
    expect(codes(edit((a) => Object.assign(a.input, { zones: 'home' })))).toEqual([]);
    expect(
      codes(
        edit((a) => {
          a.suspend = { input: 'nope', equals: ['x'] };
        }),
      ),
    ).toContain('ACCESS_INPUT');
  });
  it('hours: missing, not allowed, span, overlap, empty', () => {
    expect(
      codes(
        edit((a) => {
          delete (a.plans[1] as { hours?: object }).hours;
        }),
      ),
    ).toContain('ACCESS_HOURS_MISSING');
    expect(
      codes(edit((a) => Object.assign(a.plans[0] as object, { hours: { mon: ['06:00-10:00'] } }))),
    ).toContain('ACCESS_HOURS_NOT_ALLOWED');
    for (const span of ['6-10', '06:00-06:00', '24:00-02:00', '06:00-25:00'])
      expect(
        codes(
          edit((a) => {
            (a.plans[1] as { hours: Record<string, string[]> }).hours.wed = [span];
          }),
        ),
      ).toContain('ACCESS_HOURS_SPAN');
    expect(
      codes(
        edit((a) => {
          (a.plans[1] as { hours: Record<string, string[]> }).hours.wed = [
            '01:00-02:00',
            '03:00-04:00',
            '05:00-06:00',
            '07:00-08:00',
            '09:00-10:00',
          ];
        }),
      ),
    ).toContain('ACCESS_HOURS_SPAN');
    expect(
      codes(
        edit((a) => {
          (a.plans[1] as { hours: Record<string, string[]> }).hours.wed = [
            '06:00-10:00',
            '09:00-12:00',
          ];
        }),
      ),
    ).toContain('ACCESS_HOURS_OVERLAP');
    expect(
      codes(
        edit((a) => {
          (a.plans[1] as { hours: Record<string, string[]> }).hours = {
            mon: ['22:00-02:00'],
            tue: ['01:00-03:00'],
          };
        }),
      ),
    ).toContain('ACCESS_HOURS_OVERLAP');
    expect(
      codes(
        edit((a) => {
          (a.plans[1] as { hours: Record<string, string[]> }).hours = {
            sun: ['22:00-02:00'],
            mon: ['01:00-03:00'],
          };
        }),
      ),
    ).toContain('ACCESS_HOURS_OVERLAP');
    expect(
      codes(
        edit((a) => {
          (a.plans[1] as { hours: object }).hours = {};
        }),
      ),
    ).toContain('ACCESS_HOURS_EMPTY');
    expect(
      codes(
        edit((a) => {
          ((a.plans[1] as { zones: { hours?: object }[] }).zones[1] as { hours: object }).hours =
            {};
        }),
      ),
    ).toContain('ACCESS_HOURS_EMPTY');
  });
  it('zones: empty and key', () => {
    expect(
      codes(
        edit((a) => {
          (a.plans[0] as { zones: unknown[] }).zones = [];
        }),
      ),
    ).toContain('ACCESS_ZONES_EMPTY');
    expect(
      codes(
        edit((a) => {
          (a.plans[0] as { zones: unknown[] }).zones = [{ zone: 'Pool!' }];
        }),
      ),
    ).toContain('ACCESS_ZONE_KEY');
  });
  it('guest range', () => {
    for (const patch of [{ visits: 0 }, { visits: 1000 }, { days: 0 }, { days: 367 }])
      expect(codes(edit((a) => Object.assign(a.plans[2] as object, patch)))).toContain(
        'ACCESS_GUEST_RANGE',
      );
    expect(codes(edit((a) => Object.assign(a.plans[0] as object, { visits: 2 })))).toContain(
      'ACCESS_GUEST_RANGE',
    );
  });
  it('rules range', () => {
    for (const rules of [
      { visitGapMinutes: 721 },
      { visitGapMinutes: -1 },
      { reentryMinutes: 0 },
      { reentryMinutes: 241 },
    ])
      expect(
        codes(
          edit((a) => {
            a.rules = rules as never;
          }),
        ),
      ).toContain('ACCESS_RULES_RANGE');
    expect(
      codes(
        edit((a) => {
          a.rules = { visitGapMinutes: 0, reentryMinutes: 240 } as never;
        }),
      ),
    ).toEqual([]);
  });
  it('warns about an unknown zone key only when zones are known', () => {
    expect(codes(GOOD, undefined, ['capitol-hill'])).toEqual(['ACCESS_ZONE_UNKNOWN']);
    expect(accessIssues(manifest(GOOD), { zones: ['capitol-hill'] })[0]?.severity).toBe('warning');
    expect(codes(GOOD, undefined, ['capitol-hill', 'pool'])).toEqual([]);
  });
});
