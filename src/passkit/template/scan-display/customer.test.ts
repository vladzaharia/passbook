import { describe, expect, it } from 'vitest';
import { type CustomerViewOptions, okHeadline, renderCustomerView } from './customer.ts';
import { customerIssues } from './customer-issues.ts';
import type { ScanDisplayDoc } from './schema.ts';
import { FORMAT, NOW, scopeOf } from './test-kit.ts';

const doc = (patch: Record<string, unknown> = {}): ScanDisplayDoc =>
  ({ v: 1, header: {}, ...patch }) as ScanDisplayDoc;
const chip = (id: string, extra: object = {}) => ({ id, text: id, tone: 'teal', ...extra });
const field = (id: string, value: string, extra: object = {}) => ({
  id,
  type: 'field',
  label: 'Plan',
  value,
  ...extra,
});
const codes = (d: ScanDisplayDoc) => customerIssues(d).map((i) => i.code);
const opts = (screen: 'ready' | 'ok' | 'see_desk', more: object = {}) =>
  ({
    screen,
    ...(screen === 'ok' ? { headline: 'Checked in' } : {}),
    ref: 'ref-1',
    at: NOW,
    where: 'Front door',
    test: false,
    ...FORMAT,
    ...more,
  }) as CustomerViewOptions;
const keys = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keys)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
      : [];

describe('customerIssues', () => {
  it('accepts a block that names chips and an allowed panel', () => {
    const d = doc({
      header: { chips: [chip('c_plan')] },
      panels: [{ id: 'p', rows: [field('f', '{{pass.templateName}}')] }],
      customer: { chips: ['c_plan'], panel: 'p' },
    });
    expect(codes(d)).toEqual([]);
  });

  it('refuses unknown ids, raised elements and disallowed rows', () => {
    const d = doc({
      header: { chips: [chip('c', { minRole: 'desk' })] },
      panels: [
        {
          id: 'p',
          rows: [
            { id: 'n', type: 'note', text: 'Hi' },
            { id: 'h', type: 'history', source: 'scans', show: ['when', 'where'] },
            field('f', 'x', { minRole: 'desk' }),
          ],
        },
      ],
      customer: { chips: ['c', 'gone'], panel: 'p' },
    });
    expect(codes(d)).toEqual(
      expect.arrayContaining([
        'SCAN_DISPLAY_CUSTOMER_REF',
        'SCAN_DISPLAY_CUSTOMER_ROLE',
        'SCAN_DISPLAY_CUSTOMER_ROW',
      ]),
    );
    expect(codes(doc({ customer: { panel: 'nope' } }))).toEqual(['SCAN_DISPLAY_CUSTOMER_REF']);
  });

  it.each([
    '{{inputs.seat}}',
    '{{seat}}',
    '{{scanner.name}}',
    '{{event.capacity}}',
    '{{event.arrived}}',
    '{{pass.externalId}}',
    '{{access.zone}}',
    '{{access.hours}}',
  ])('refuses %s in a named panel', (binding) => {
    const d = doc({
      panels: [{ id: 'p', rows: [field('f', binding)] }],
      customer: { panel: 'p' },
    });
    expect(codes(d)).toEqual(['SCAN_DISPLAY_CUSTOMER_SCOPE']);
  });

  it('lets the customer read the plan and when the access ends', () => {
    const d = doc({
      panels: [{ id: 'p', rows: [field('f', '{{access.plan}} {{access.until|time}}')] }],
      customer: { panel: 'p' },
    });
    expect(codes(d)).toEqual([]);
  });

  it('reads bindings of named elements only', () => {
    const d = doc({
      panels: [
        { id: 'p', rows: [field('f', '{{pass.templateName}}')] },
        { id: 'staff', rows: [field('g', '{{inputs.seat}}')] },
      ],
      customer: { panel: 'p' },
    });
    expect(codes(d)).toEqual([]);
  });

  it('caps the panel at 4 units', () => {
    const rows = Array.from({ length: 5 }, (_, i) => field(`f${i}`, '{{pass.templateName}}'));
    expect(codes(doc({ panels: [{ id: 'p', rows }], customer: { panel: 'p' } }))).toEqual([
      'SCAN_DISPLAY_CUSTOMER_DENSITY',
    ]);
  });
});

describe('renderCustomerView', () => {
  const named = doc({
    holder: '{{pass.title}}',
    header: { chips: [chip('c_plan'), chip('c_staff')] },
    panels: [
      {
        id: 'p',
        rows: [
          field('f', '{{pass.templateName}}'),
          { id: 'n', type: 'note', text: 'Staff only' },
          field('s', '{{inputs.seat}}'),
        ],
      },
      { id: 'other', rows: [field('o', 'Other panel')] },
    ],
    notes: { staff: 'Check ID', refused: 'Banned' },
    customer: { chips: ['c_plan'], panel: 'p' },
  });
  const scope = scopeOf(
    { seat: 'F12' },
    {
      pass: { title: 'Anna Meyer', templateName: 'Gala', externalId: 'EXT-9' },
      scanner: { name: 'Door' },
    },
  );

  it('greets by first name on ok and shows only what the block names', () => {
    const view = renderCustomerView(named, scope, opts('ok'));
    expect(view.greet).toBe('Hi, Anna');
    expect(view.band).toEqual({ headline: 'Checked in', sub: null });
    expect(view.chips.map((c) => c.text)).toEqual(['c_plan']);
    expect(view.panel?.rows).toHaveLength(1);
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/Meyer|Staff only|F12|EXT-9|Check ID|Banned|Other panel/);
  });

  it('names the ok headline from the caller, with the system words as its default', () => {
    expect(okHeadline({})).toBe('Checked in');
    expect(okHeadline({ direction: 'out' })).toBe('Checked out');
    expect(okHeadline({ event: true })).toBe('Checked in');
    expect(okHeadline({ access: true })).toBe('Checked in');
    const paid = opts('ok', { headline: 'Paid $12.00', sub: 'Balance $30.50' });
    expect(renderCustomerView(named, scope, paid).band).toEqual({
      headline: 'Paid $12.00',
      sub: 'Balance $30.50',
    });
  });

  it('shows a draft as the ready card with the amount', () => {
    const review = { screen: 'review', headline: 'To pay $12.00', sub: 'Balance after: $30.50' };
    const view = renderCustomerView(named, scope, opts('ready', review));
    expect(view).toMatchObject({
      screen: 'review',
      greet: 'Hi, Anna',
      band: { headline: 'To pay $12.00', sub: 'Balance after: $30.50' },
    });
    expect(view.panel?.rows).toHaveLength(1);
  });

  it('puts the greeting in the band on ready, and says Hello without a name', () => {
    expect(renderCustomerView(named, scope, opts('ready', { sub: 'Gala' })).band).toEqual({
      headline: 'Hi, Anna',
      sub: 'Gala',
    });
    const nameless = scopeOf({}, { pass: { templateName: 'Gala' } });
    const view = renderCustomerView(doc({ header: {} }), nameless, opts('ready'));
    expect(view.greet).toBeNull();
    expect(view.band.headline).toBe('Hello');
  });

  it('does not greet when the session or the doc turns it off', () => {
    expect(renderCustomerView(named, scope, opts('ok', { greet: false })).greet).toBeNull();
    const off = { ...named, customer: { ...named.customer, greet: false } } as ScanDisplayDoc;
    expect(renderCustomerView(off, scope, opts('ok')).greet).toBeNull();
  });

  it('shows nothing from the doc on see_desk and carries no reason', () => {
    const view = renderCustomerView(named, scope, opts('see_desk', { refusedLine: 'Ask inside' }));
    expect(view).toMatchObject({ band: { headline: 'Ask inside', sub: null }, greet: null });
    expect(view.chips).toEqual([]);
    expect(view.panel).toBeNull();
    expect(keys(view)).not.toEqual(expect.arrayContaining(['reason', 'staff', 'photo', 'passId']));
  });

  it('uses the default panel when the doc has no customer block', () => {
    const d = doc({
      holder: '{{pass.title}}',
      panels: [
        {
          id: 'b',
          preset: { id: 'balance', v: 1 },
          rows: [field('f', '{{pass.templateName}}')],
        },
        { id: 'x', rows: [field('g', 'Hidden')] },
      ],
    });
    const view = renderCustomerView(d, scope, opts('ok'));
    expect(view.panel?.id).toBe('b');
  });

  it('falls back to the band when rendering fails', () => {
    const failures: unknown[] = [];
    const view = renderCustomerView(named, scope, {
      ...opts('ok', { onError: (e: unknown) => failures.push(e) }),
      ref: '',
    });
    expect(failures).toHaveLength(1);
    expect(view.panel).toBeNull();
    expect(view.greet).toBeNull();
  });
});
