import { describe, expect, it } from 'vitest';
import type { PassJson, TemplateManifest } from '../../types.ts';
import type { ScanDisplayDoc } from './schema.ts';
import { manifestOf } from './test-kit.ts';
import { scanDisplayIssues } from './validate.ts';

const inputs = {
  attendee: { type: 'string' },
  tier: { type: 'string', 'x-scan': 'desk' },
  seat: { type: 'string' },
  stamps: { type: 'integer' },
  balance: { type: 'number' },
  email: { type: 'string', format: 'email' },
  kind: { type: 'string', enum: ['a', 'b'] },
};
const actions = [
  { id: 'add_stamp', label: 'Add stamp', kind: 'add' as const, input: 'stamps' },
  { id: 'charge', label: 'Charge', kind: 'take' as const, input: 'balance', amount: 1 },
];

const row = (extra: object) => ({
  id: 'r_a',
  type: 'field',
  label: 'Seat',
  value: '{{inputs.seat}}',
  ...extra,
});
const doc = (patch: Record<string, unknown> = {}): ScanDisplayDoc =>
  ({ v: 1, header: {}, ...patch }) as ScanDisplayDoc;
const panelOf = (rows: object[], extra: object = {}) => ({ id: 'p_a', rows, ...extra });
const manifestFor = (display: unknown, scan: Parameters<typeof manifestOf>[1] = { actions }) =>
  manifestOf(inputs, scan, display as ScanDisplayDoc);
const codes = (
  display: unknown,
  severity?: 'error' | 'warning',
  m?: TemplateManifest,
  passJson?: PassJson,
) =>
  scanDisplayIssues(m ?? manifestFor(display), { passJson })
    .filter((i) => !severity || i.severity === severity)
    .map((i) => i.code.replace('SCAN_DISPLAY_', ''));

describe('errors', () => {
  it('passes a clean doc and a manifest with no display', () => {
    expect(codes(doc({ panels: [panelOf([row({})])] }))).toEqual([]);
    expect(scanDisplayIssues(manifestOf(inputs))).toEqual([]);
  });

  it('TOO_BIG before parsing', () => {
    const big = doc({
      notes: { staff: 'x'.repeat(500) },
      panels: Array.from({ length: 6 }, (_, i) =>
        panelOf(
          Array.from({ length: 6 }, (_, j) => row({ id: `r${i}${j}`, value: 'x'.repeat(500) })),
          { id: `p${i}` },
        ),
      ),
    });
    expect(codes(big)).toEqual(['TOO_BIG']);
  });

  it('SHAPE with the JSON path of an unknown key', () => {
    const issues = scanDisplayIssues(
      manifestFor(doc({ panels: [panelOf([row({ color: 'red' })])] })),
    );
    expect(issues[0]).toMatchObject({
      code: 'SCAN_DISPLAY_SHAPE',
      path: 'scan.display.panels.0.rows.0.color',
    });
    expect(
      codes(
        doc({
          panels: [
            panelOf([
              {
                id: 'r_a',
                type: 'columns',
                items: Array.from({ length: 5 }, (_, i) => ({
                  id: `i${i}`,
                  label: 'a',
                  value: 'b',
                })),
              },
            ]),
          ],
        }),
      ),
    ).toContain('TOO_MANY');
    expect(
      codes(doc({ panels: [panelOf([{ id: 'r_a', type: 'image', source: 'photo' }])] })),
    ).toContain('SHAPE');
  });

  it('VERSION, ICON, TONE, ID, TEXT_LENGTH, EXPR and CONDITION from the shape', () => {
    expect(codes({ v: 2, header: {} })).toEqual(['VERSION']);
    expect(codes(doc({ header: { icon: 'check' } }))).toEqual(['ICON']);
    expect(codes(doc({ header: { chips: [{ id: 'c_a', text: 'x', tone: 'green' }] } }))).toEqual([
      'TONE',
    ]);
    expect(codes(doc({ panels: [panelOf([row({})], { id: 'Bad Id' })] }))).toEqual(['ID']);
    expect(codes(doc({ notes: { refused: 'x'.repeat(101) } }))).toEqual(['TEXT_LENGTH']);
    expect(codes(doc({ holder: '{{inputs.attendee' }))).toContain('EXPR');
    expect(codes(doc({ holder: '{{inputs.attendee|upper}}' }))).toContain('EXPR');
    expect(
      codes(
        doc({
          variants: [{ id: 'v_a', name: 'A', when: { path: 'a', eq: 1, gt: 2 }, header: {} }],
        }),
      ),
    ).toContain('CONDITION');
  });

  it('ID for a duplicate', () => {
    const rows = [row({}), row({ value: 'x' })];
    expect(codes(doc({ panels: [panelOf(rows)] }))).toContain('ID');
  });

  it('TEXT_LENGTH for a literal over its cap, not for a binding', () => {
    expect(codes(doc({ panels: [panelOf([row({ label: 'x'.repeat(21) })])] }))).toContain(
      'TEXT_LENGTH',
    );
    expect(
      codes(
        doc({ panels: [panelOf([row({ label: '{{inputs.seat}}'.padEnd(40, 'x') })])] }),
        'error',
      ),
    ).toEqual([]);
  });

  it('EXPR and FILTER', () => {
    expect(codes(doc({ panels: [panelOf([row({ value: '{{inputs.seat' })])] }))).toContain('EXPR');
    expect(codes(doc({ panels: [panelOf([row({ value: '{{inputs.seat|html}}' })])] }))).toContain(
      'FILTER',
    );
    expect(codes(doc({ panels: [panelOf([row({ value: '{{inputs.seat|wiggle}}' })])] }))).toContain(
      'FILTER',
    );
    expect(
      codes(doc({ panels: [panelOf([row({ value: '{{inputs.seat|upper}}' })])] }), 'error'),
    ).toEqual([]);
  });

  it('SECRET for a secret input, pass.scanCode and a hidden field', () => {
    expect(codes(doc({ panels: [panelOf([row({ value: '{{inputs.email}}' })])] }))).toContain(
      'SECRET',
    );
    expect(codes(doc({ panels: [panelOf([row({ value: '{{pass.scanCode}}' })])] }))).toContain(
      'SECRET',
    );
    expect(
      codes(
        doc({
          variants: [
            { id: 'v_a', name: 'A', when: { path: 'pass.scanCode', eq: 'x' }, header: {} },
          ],
        }),
      ),
    ).toContain('SECRET');
    const m = manifestFor(doc({ panels: [panelOf([row({ value: '{{fields.code}}' })])] }));
    m.bindings = [{ to: { field: 'code' }, value: '{{pass.scanCode}}' }];
    expect(codes(null, undefined, m)).toContain('SECRET');
  });

  it('DENSITY for a card over 5 units and for ok over its capacity; CUT as a warning elsewhere', () => {
    const big = { id: 'r_b', type: 'big', value: '{{inputs.seat}}' };
    const three = [big, { ...big, id: 'r_c' }, row({ id: 'r_d' })];
    expect(
      codes(
        doc({ panels: [panelOf([...three, row({ id: 'r_e' }), row({ id: 'r_f' })])] }),
        'error',
      ),
    ).toContain('DENSITY');
    const twoCards = doc({
      panels: [panelOf(three, { id: 'p_a' }), panelOf(three, { id: 'p_b' })],
    });
    expect(codes(twoCards, 'error')).toContain('DENSITY');
    const headsUp = doc({
      panels: [
        panelOf(
          [row({}), row({ id: 'r_b' }), row({ id: 'r_c' }), row({ id: 'r_d' }), row({ id: 'r_e' })],
          { on: ['heads_up'] },
        ),
      ],
    });
    expect(codes(headsUp, 'warning')).toContain('CUT');
    expect(codes(headsUp, 'error')).toEqual([]);
  });

  it('PLACEMENT', () => {
    const image = { id: 'r_i', type: 'image', source: 'thumbnail' };
    expect(codes(doc({ panels: [panelOf([row({}), image])] }))).toContain('PLACEMENT');
    expect(codes(doc({ panels: [panelOf([{ id: 'r_d', type: 'divider' }, row({})])] }))).toContain(
      'PLACEMENT',
    );
    expect(
      codes(doc({ panels: [panelOf([row({}), { id: 'r_h', type: 'heading', text: 'More' }])] })),
    ).toContain('PLACEMENT');
    const bigs = ['r_1', 'r_2', 'r_3'].map((id) => ({ id, type: 'big', value: '1' }));
    expect(codes(doc({ panels: [panelOf(bigs)] }))).toContain('PLACEMENT');
    expect(
      codes(
        doc({
          panels: [
            panelOf([
              {
                id: 'r_s',
                type: 'progress',
                value: '{{inputs.stamps}}',
                goal: 12,
                style: 'stamps',
              },
            ]),
          ],
        }),
      ),
    ).toContain('PLACEMENT');
    const history = (id: string) => ({ id, type: 'history', source: 'visits' });
    expect(
      codes(doc({ panels: [panelOf([history('r_1')]), panelOf([history('r_2')], { id: 'p_b' })] })),
    ).toContain('PLACEMENT');
  });

  it('HOLDER for text, a filter, a non-string input and a stray root', () => {
    for (const holder of [
      'plain text',
      '{{inputs.attendee}} x',
      '{{inputs.stamps}}',
      '{{scan.reason}}',
    ])
      expect(codes(doc({ holder }))).toContain('HOLDER');
    for (const holder of [
      '{{inputs.attendee}}',
      '{{attendee}}',
      '{{pass.title}}',
      '{{fields.name}}',
    ])
      expect(codes(doc({ holder }), 'error')).toEqual([]);
  });

  it('TITLE: bindings, filters, caps, verdict words and a holder that is not a name', () => {
    const title = (t: unknown, holder: string | null = '{{inputs.attendee}}') =>
      codes(doc({ ...(holder ? { holder } : {}), header: { title: t } }), 'error');
    expect(title('Welcome back, {{holder.firstName}}')).toEqual([]);
    expect(title('Hi {{inputs.tier}}')).toContain('TITLE');
    expect(title('Hi {{holder.name|upper}}')).toContain('TITLE');
    expect(title('x'.repeat(29))).toContain('TITLE');
    expect(title(`${'x'.repeat(21)} {{holder.name}}`)).toContain('TITLE');
    expect(title('Refunded')).toContain('TITLE');
    expect(title('Hi {{holder.name}}', '{{pass.title}}')).toContain('TITLE');
    expect(title('Hi {{holder.name}}', null)).toContain('TITLE');
    expect(title('Hi {{holder.name}}', '{{inputs.kind}}')).toContain('TITLE');
    expect(
      title({ count: '{{inputs.stamps}}', one: 'One', other: 'Many {{holder.name}}' }),
    ).toEqual([]);
  });

  it('ACTION, HISTORY_INPUT, GOAL and CURRENCY', () => {
    expect(codes(doc({ panels: [panelOf([row({})], { actions: ['nope'] })] }))).toContain('ACTION');
    expect(
      codes(
        doc({
          panels: [
            panelOf([
              { id: 'r_m', type: 'money', amount: '{{inputs.balance}}', pending: ['nope'] },
            ]),
          ],
        }),
      ),
    ).toContain('ACTION');
    expect(
      codes(
        doc({
          panels: [panelOf([{ id: 'r_h', type: 'history', source: 'value', input: 'seat' }])],
        }),
      ),
    ).toContain('HISTORY_INPUT');
    expect(
      codes(doc({ panels: [panelOf([row({ value: '{{history.ledger.seat.last.amount}}' })])] })),
    ).toContain('HISTORY_INPUT');
    expect(
      codes(
        doc({ panels: [panelOf([{ id: 'r_p', type: 'progress', value: '{{inputs.stamps}}' }])] }),
      ),
    ).toContain('GOAL');
    expect(
      codes(
        doc({ panels: [panelOf([{ id: 'r_p', type: 'progress', value: '{{inputs.balance}}' }])] }),
        'error',
      ),
    ).toEqual([]);
    expect(codes(doc({ currency: 'DOLLARS' }))).toContain('CURRENCY');
    expect(codes(doc({ currency: 'USD' }))).toEqual([]);
  });

  it('CONDITION for a condition nested past 4 levels', () => {
    const deep = { not: { not: { not: { not: { path: 'inputs.seat', eq: 1 } } } } };
    expect(codes(doc({ panels: [panelOf([row({})], { when: deep })] }))).toContain('CONDITION');
  });
});

describe('warnings', () => {
  it('PATH, SHADOWED, ROLE_CONDITION, ROLE_EMPTY and TYPE', () => {
    expect(
      codes(doc({ panels: [panelOf([row({ value: '{{inputs.nope}}' })])] }), 'warning'),
    ).toContain('PATH');
    expect(
      codes(doc({ panels: [panelOf([row({ value: '{{fields.nope}}' })])] }), 'warning', undefined, {
        generic: { primaryFields: [] },
      } as unknown as PassJson),
    ).toContain('PATH');
    const shadow = manifestOf({ ...inputs, scan: { type: 'string' } }, {}, doc());
    expect(codes(null, 'warning', shadow)).toContain('SHADOWED');
    expect(
      codes(
        doc({ panels: [panelOf([row({})], { when: { path: 'inputs.tier', eq: 'VIP' } })] }),
        'warning',
      ),
    ).toContain('ROLE_CONDITION');
    expect(
      codes(doc({ panels: [panelOf([row({ value: '{{inputs.tier}}' })])] }), 'warning'),
    ).toContain('ROLE_EMPTY');
    expect(
      codes(
        doc({ panels: [panelOf([{ id: 'r_m', type: 'money', amount: '{{inputs.seat}}' }])] }),
        'warning',
      ),
    ).toContain('TYPE');
  });

  it('PANELS_HIDDEN, VARIANT_UNREACHABLE, VERDICT_WORD, COLUMNS_WRAP and IMAGE', () => {
    const three = ['p_a', 'p_b', 'p_c'].map((id) => panelOf([row({ id: `${id}_r` })], { id }));
    expect(codes(doc({ panels: three }), 'warning')).toContain('PANELS_HIDDEN');
    const when = { path: 'inputs.seat', eq: 'A' };
    expect(
      codes(
        doc({ variants: [1, 2].map((n) => ({ id: `v_${n}`, name: 'V', when, header: {} })) }),
        'warning',
      ),
    ).toContain('VARIANT_UNREACHABLE');
    expect(codes(doc({ notes: { staff: 'Entry denied after 9' } }), 'warning')).toContain(
      'VERDICT_WORD',
    );
    const wide = {
      id: 'r_c',
      type: 'columns',
      size: 'big',
      items: [
        { id: 'i_a', label: 'a', value: 'abcdefghij' },
        { id: 'i_b', label: 'b', value: '1' },
      ],
    };
    expect(codes(doc({ panels: [panelOf([wide])] }), 'warning')).toContain('COLUMNS_WRAP');
    const image = { id: 'r_i', type: 'image', source: 'strip' };
    const m = manifestFor(doc({ panels: [panelOf([image])] }));
    expect(scanDisplayIssues(m, { assetNames: ['icon@2x.png'] }).map((i) => i.code)).toContain(
      'SCAN_DISPLAY_IMAGE',
    );
    expect(scanDisplayIssues(m, { assetNames: ['strip@2x.png'] }).map((i) => i.code)).not.toContain(
      'SCAN_DISPLAY_IMAGE',
    );
  });

  it('lists errors before warnings', () => {
    const issues = scanDisplayIssues(
      manifestFor(
        doc({
          holder: '{{inputs.stamps}}',
          panels: [panelOf([row({ value: '{{inputs.nope}}' })])],
        }),
      ),
    );
    const firstWarning = issues.findIndex((i) => i.severity === 'warning');
    expect(issues.slice(firstWarning).every((i) => i.severity === 'warning')).toBe(true);
  });
});
