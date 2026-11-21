import { describe, expect, it } from 'vitest';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { suggestMapping } from '@/shared/issuing/matcher.ts';
import { importDto } from './import-test-fixtures.ts';
import { planOfState, setColumns, shownRows, stateOfImport } from './match-model.ts';

const SCHEMA = {
  type: 'object',
  required: ['name', 'memberId'],
  properties: {
    name: { type: 'string', 'x-label': 'Name', 'x-order': 1 },
    memberId: { type: 'string', 'x-label': 'Member ID', 'x-order': 2 },
    plan: {
      type: 'string',
      enum: ['monthly', 'annual'],
      'x-enumLabels': { monthly: 'Monthly', annual: 'Annual' },
      'x-order': 3,
    },
    paidThrough: { type: 'string', format: 'date', 'x-label': 'Paid through', 'x-order': 4 },
  },
};

const columns = [
  { pointer: '/First name', label: 'First name', samples: ['Ana', 'Ben'] },
  { pointer: '/Last name', label: 'Last name', samples: ['Ruiz', 'Cole'] },
  { pointer: '/Member #', label: 'Member #', samples: ['M-200', 'M-201'] },
  { pointer: '/Membership', label: 'Membership', samples: ['monthly', 'Gold'] },
  { pointer: '/Expires', label: 'Expires', samples: ['12/31/2026', '01/31/2027'] },
  { pointer: '/Phone', label: 'Phone', samples: ['555'] },
];

// The server reads the whole file; the page gets its suggestion in `mapping`.
const grid = Array.from({ length: 12 }, (_, i) => [
  `N${i}`,
  `L${i}`,
  `M-${200 + i}`,
  i === 11 ? 'Gold' : 'monthly',
  `0${(i % 9) + 1}/28/2026`,
  '555',
]);
const mapping = suggestMapping(
  SCHEMA,
  columns.map((c) => c.label),
  grid,
);
const imp = (over: Record<string, unknown> = {}) =>
  importDto({ columns, mapping, ...over }) as unknown as PassImportDto;

describe('stateOfImport', () => {
  it('joins first and last name, matches by the ID input, and lists unused columns', () => {
    const state = stateOfImport(imp(), SCHEMA);
    const name = state.rows.find((r) => r.target === 'name');
    expect(name?.from).toEqual(['/First name', '/Last name']);
    expect(name?.confidence).toBe('join');
    expect(state.find).toBe('col:input:memberId');
    expect(state.unused.map((u) => u.label)).toContain('Phone');
    expect(shownRows(state).some((r) => r.role === 'externalId')).toBe(false);
  });
});

describe('planOfState', () => {
  it('writes the join, the enum labels with picked values, and the date format', () => {
    const state = stateOfImport(imp(), SCHEMA);
    const rows = state.rows.map((r) =>
      r.target === 'plan'
        ? { ...r, values: r.values.map((v) => (v.to === null ? { ...v, to: 'annual' } : v)) }
        : r,
    );
    const { plan, errors } = planOfState({ ...state, rows }, { keepManual: false, save: true });
    expect(errors).toEqual({});
    expect(plan?.mapping.name).toEqual({
      from: '/First name',
      transform: { kind: 'join', options: { with: ['/Last name'] } },
    });
    expect(plan?.mapping.plan?.transform?.options?.map).toEqual({
      Gold: 'annual',
      monthly: 'monthly',
    });
    expect(plan?.mapping.paidThrough?.transform).toMatchObject({
      kind: 'date',
      options: { input: 'mdy', output: 'date' },
    });
    expect(plan?.match).toBe('externalId');
    expect(plan?.externalId).toEqual({ from: '/Member #' });
  });

  it('asks for the date format when two fit equally', () => {
    const state = stateOfImport(imp(), SCHEMA);
    const rows = state.rows.map((r) =>
      r.target === 'paidThrough' && r.date
        ? { ...r, date: { ...r.date, format: null, choices: ['mdy' as const, 'dmy' as const] } }
        : r,
    );
    const result = planOfState({ ...state, rows }, { keepManual: false, save: true });
    expect(result.plan).toBeUndefined();
    expect(result.errors['input:paidThrough']).toBe('Choose how dates are written.');
  });

  it('refuses to match on a column that was cleared', () => {
    const state = stateOfImport(imp(), SCHEMA);
    const rows = state.rows.map((r) => (r.target === 'memberId' ? setColumns(r, [], columns) : r));
    const result = planOfState({ ...state, rows }, { keepManual: false, save: true });
    expect(result.matchError).toBe('Map an External ID column to match on it.');
  });

  it('keeps the cell fixes the check made', () => {
    const state = stateOfImport(imp(), SCHEMA);
    const overrides = { 58: { '/Membership': 'Annual' } };
    const { plan } = planOfState(state, { keepManual: true, save: false, overrides });
    expect(plan?.overrides).toEqual(overrides);
    expect(plan?.keepManual).toBe(true);
  });
});

describe('the saved plan over the suggestion', () => {
  it('shows what the plan chose: a cleared field stays empty, a picked value stays picked', () => {
    const base = planOfState(stateOfImport(imp(), SCHEMA), { keepManual: false, save: true }).plan;
    if (!base) throw new Error('plan');
    const { paidThrough: _gone, ...mapping } = base.mapping;
    const state = stateOfImport(imp({ plan: { ...base, mapping } }), SCHEMA);
    expect(state.rows.find((r) => r.target === 'paidThrough')?.from).toEqual([]);
    expect(state.rows.find((r) => r.target === 'name')?.from).toHaveLength(2);
    expect(state.find).toBe('col:input:memberId');
  });
});
