import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MappingFieldSuggestion, MappingSuggestion } from '../contracts/issuing.ts';
import { parseCsv } from '../csv/parse.ts';
import { toCsv } from '../csv/write.ts';
import { applyMapping } from '../mapping/transform.ts';
import { inputFields } from './fields.ts';
import { planOfSuggestion, suggestMapping } from './matcher.ts';

const monthly = JSON.parse(
  readFileSync('templates/starter-monthly-pass/wallet.template.json', 'utf8'),
) as {
  inputs: { properties: Record<string, Record<string, unknown>> };
  sample: Record<string, unknown>;
};

const field = (s: MappingSuggestion, target: string): MappingFieldSuggestion => {
  const f = s.fields.find((x) => x.target === target);
  if (!f) throw new Error(`no ${target}`);
  return f;
};

const suggest = (schema: unknown, csv: string, idInput?: string) => {
  const parsed = parseCsv(csv);
  return {
    parsed,
    s: suggestMapping(
      schema,
      parsed.header,
      parsed.rows.map((r) => r.cells),
      { idInput },
    ),
  };
};

describe('the template sample CSV', () => {
  // The sample's headers are the field labels plus Holder email, with one valid row.
  const labels = inputFields(monthly.inputs).map((f) => f.label);
  const csv = toCsv(
    ['Holder email', ...labels],
    [
      [
        'alex@example.com',
        'Alex Morgan',
        'MEMBER-0001',
        'Active',
        'Monthly',
        '2030-01-01',
        '2',
        'Welcome',
        '',
      ],
    ],
  );
  const { parsed, s } = suggest(monthly.inputs, csv, 'memberId');

  it('maps every column exactly', () => {
    expect(s.unused).toEqual([]);
    expect(s.used).toBe(s.columns);
    expect(s.missing).toEqual([]);
    for (const f of s.fields.filter((x) => x.role !== 'externalId'))
      expect([f.target, f.confidence]).toEqual([f.target, 'exact']);
  });

  it('feeds External ID from the Member ID column and matches on it', () => {
    expect(field(s, 'externalId').from).toEqual(['/Member ID']);
    expect(field(s, 'memberId').matchBy).toBe(true);
    expect(field(s, 'externalId').matchBy).toBe(false);
  });

  it('turns the row into the template input', () => {
    const plan = planOfSuggestion(s);
    const record = Object.fromEntries(
      parsed.header.map((h, i) => [h, parsed.rows[0]?.cells[i] ?? '']),
    );
    expect(applyMapping(plan.mapping, record)).toEqual({
      memberName: 'Alex Morgan',
      memberId: 'MEMBER-0001',
      status: 'Active',
      plan: 'member',
      validUntil: '2030-01-01T00:00:00.000Z',
      guests: '2',
      message: 'Welcome',
      note: '',
    });
    expect(plan.match).toBe('externalId');
  });
});

// The walkthrough's gym export, against a template with three plans.
const threePlans = structuredClone(monthly.inputs);
Object.assign(threePlans.properties.plan as Record<string, unknown>, {
  enum: ['member', 'annual', 'day'],
  'x-enumLabels': { member: 'Monthly', annual: 'Annual', day: 'Day' },
});
const plans = ['monthly', 'ANNUAL', 'Day', 'monthly', 'monthly', 'annual', 'annual', 'Monthly'];
const exportRows = Array.from({ length: 24 }, (_, i) => [
  `member${i}@example.com`,
  ['Kai', 'Ana', 'Lee'][i % 3] as string,
  ['Osei', 'Ruiz', 'Park'][i % 3] as string,
  `M-${2000 + i}`,
  i === 5 ? 'Gold' : (plans[i % plans.length] as string),
  `${String((i % 12) + 1).padStart(2, '0')}/${String((i % 28) + 1).padStart(2, '0')}/2026`,
  String(i % 4),
  `+1 555 01${String(i).padStart(2, '0')}`,
]);
const exportCsv = toCsv(
  [
    'Email',
    'First name',
    'Last name',
    'Member #',
    'Membership',
    'Expires',
    'Guest passes',
    'Phone',
  ],
  exportRows,
);

describe('the walkthrough export', () => {
  const { s } = suggest(threePlans, exportCsv, 'memberId');

  it('maps Email, the name join, Member # and Membership by values', () => {
    expect(field(s, 'holderEmail')).toMatchObject({ from: ['/Email'], confidence: 'similar' });
    expect(field(s, 'memberName')).toMatchObject({
      from: ['/First name', '/Last name'],
      confidence: 'join',
      entry: {
        from: '/First name',
        transform: { kind: 'join', options: { with: ['/Last name'] } },
      },
    });
    expect(field(s, 'memberId')).toMatchObject({ from: ['/Member #'], confidence: 'similar' });
    expect(field(s, 'plan')).toMatchObject({ from: ['/Membership'], confidence: 'values' });
    expect(field(s, 'guests')).toMatchObject({ from: ['/Guest passes'], confidence: 'similar' });
    expect(field(s, 'validUntil')).toMatchObject({ from: ['/Expires'], confidence: 'similar' });
  });

  it('maps plan values value by value and asks about the unknown one', () => {
    const values = Object.fromEntries(field(s, 'plan').values.map((v) => [v.value, v.to]));
    expect(values).toMatchObject({ monthly: 'member', ANNUAL: 'annual', Day: 'day', Gold: null });
  });

  it('lists the unused column and the unmatched fields', () => {
    expect(s.unused).toEqual([{ pointer: '/Phone', label: 'Phone' }]);
    expect(s.used).toBe(7);
    expect(s.missing).toEqual([]);
    for (const key of ['status', 'message', 'note']) expect(field(s, key).entry).toBeNull();
  });

  it('feeds Member ID and External ID from one column', () => {
    expect(field(s, 'externalId')).toMatchObject({ from: ['/Member #'], matchBy: false });
    expect(field(s, 'memberId').matchBy).toBe(true);
    expect(planOfSuggestion(s).externalId).toEqual({ from: '/Member #' });
  });

  it('applies the join, the plan labels and the US dates', () => {
    const plan = planOfSuggestion(s);
    const input = applyMapping(plan.mapping, {
      'First name': 'Kai',
      'Last name': 'Osei',
      'Member #': 'M-2001',
      Membership: 'ANNUAL',
      Expires: '12/31/2026',
      'Guest passes': '3',
    });
    expect(input).toEqual({
      memberName: 'Kai Osei',
      memberId: 'M-2001',
      plan: 'annual',
      validUntil: '2026-12-31T00:00:00.000Z',
      guests: '3',
    });
  });

  it('keeps an explicit External ID column for External ID', () => {
    const csv = toCsv(['External ID', 'Member ID'], [['ext-1', 'M-1']]);
    const r = suggest(monthly.inputs, csv, 'memberId').s;
    expect(field(r, 'externalId')).toMatchObject({
      from: ['/External ID'],
      confidence: 'exact',
      matchBy: true,
    });
    expect(field(r, 'memberId')).toMatchObject({ from: ['/Member ID'], matchBy: false });
  });

  it('finds the ID input by its label without a lookup input', () => {
    const csv = toCsv(['Member ID'], [['M-1']]);
    expect(field(suggest(monthly.inputs, csv).s, 'externalId').from).toEqual(['/Member ID']);
  });
});

describe('enum labels', () => {
  it('match keys and labels ignoring case', () => {
    const csv = toCsv(
      ['Plan', 'Status'],
      [
        ['MONTHLY', 'active'],
        ['member', 'SUSPENDED'],
      ],
    );
    const s = suggest(monthly.inputs, csv).s;
    expect(field(s, 'plan').values.map((v) => v.to)).toEqual(['member', 'member']);
    expect(field(s, 'status').values.map((v) => v.to)).toEqual(['Active', 'Suspended']);
    const plan = planOfSuggestion(s);
    expect(applyMapping(plan.mapping, { Plan: 'monthly', Status: 'Active' })).toEqual({
      plan: 'member',
      status: 'Active',
    });
  });

  it('do not match by values below 90% or under 5 samples', () => {
    const few = toCsv(['Tier'], [['Monthly'], ['Monthly']]);
    expect(field(suggest(monthly.inputs, few).s, 'plan').from).toEqual([]);
    const mixed = toCsv(
      ['Tier'],
      ['Monthly', 'Monthly', 'Monthly', 'Gold', 'Silver'].map((v) => [v]),
    );
    expect(field(suggest(monthly.inputs, mixed).s, 'plan').from).toEqual([]);
  });
});

describe('a plan column with a few unknown values', () => {
  // The design sets the line: 90% of the non-empty cells must fit (analysis.md, risks). Below it the
  // column is left for the person to choose; at or above it the unknown values ask "Choose".
  const membership = (rows: number, gold: number) =>
    toCsv(
      ['Membership'],
      Array.from({ length: rows }, (_, i) => [
        i < gold ? 'Gold' : (['monthly', 'ANNUAL', 'Day'][i % 3] as string),
      ]),
    );

  it('is left unmatched when 3 of 24 cells (87.5% fit) are not plans', () => {
    const { s } = suggest(threePlans, membership(24, 3), 'memberId');
    expect(field(s, 'plan').from).toEqual([]);
    expect(s.unused).toEqual([{ pointer: '/Membership', label: 'Membership' }]);
  });

  it('maps by values when 3 of 40 cells (92.5% fit) are not plans, and asks about Gold', () => {
    const { s } = suggest(threePlans, membership(40, 3), 'memberId');
    expect(field(s, 'plan')).toMatchObject({ from: ['/Membership'], confidence: 'values' });
    const values = Object.fromEntries(field(s, 'plan').values.map((v) => [v.value, v.to]));
    expect(values).toMatchObject({ monthly: 'member', ANNUAL: 'annual', Day: 'day', Gold: null });
  });
});

describe('date detection', () => {
  const dates = (values: string[]) =>
    field(
      suggest(
        monthly.inputs,
        toCsv(
          ['Paid through'],
          values.map((v) => [v]),
        ),
      ).s,
      'validUntil',
    );

  it('reads month-first dates when a day is past 12', () => {
    const f = dates(['01/15/2026', '02/03/2026', '12/31/2026']);
    expect(f.date).toEqual({ format: 'mdy', choices: [], parsed: 3, total: 3 });
    expect(f.entry?.transform).toEqual({
      kind: 'date',
      options: { input: 'mdy', output: 'iso', keepOffset: true },
    });
  });

  it('reads day-first dates', () => {
    expect(dates(['31/01/2026', '03/02/2026']).date?.format).toBe('dmy');
  });

  it('asks when day-first and month-first both read every date', () => {
    const f = dates(['01/02/2026', '03/04/2026', '05/06/2026']);
    expect(f.date).toEqual({ format: null, choices: ['mdy', 'dmy'], parsed: 3, total: 3 });
    expect(f.entry).toBeNull();
    expect(f.from).toEqual(['/Paid through']);
  });

  it('counts the cells that parse', () => {
    expect(dates(['2026-01-01', '2026-02-01', 'soon']).date).toMatchObject({
      format: 'ymd',
      parsed: 2,
      total: 3,
    });
  });

  it('matches an unnamed date column by its values', () => {
    const values = ['01/15/2026', '02/16/2026', '03/17/2026', '04/18/2026', '05/19/2026'];
    const s = suggest(
      monthly.inputs,
      toCsv(
        ['Col A'],
        values.map((v) => [v]),
      ),
    ).s;
    expect(field(s, 'validUntil')).toMatchObject({ from: ['/Col A'], confidence: 'values' });
  });
});
