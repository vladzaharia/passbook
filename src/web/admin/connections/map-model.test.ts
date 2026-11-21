import { describe, expect, it } from 'vitest';
import { SKIP } from '../passes/import/match-model.ts';
import { INPUT_SCHEMA } from '../passes/test-fixtures.ts';
import { mapOfState, stateOfConnection } from './map-model.ts';

const preview = {
  ok: true,
  records: 9,
  counts: { create: 0, update: 0, unchanged: 0, skipped: 0, errors: 0 },
  samples: [],
  durationMs: 1,
  columns: [
    { pointer: '/memberName', label: 'memberName', samples: ['Maya', 'Sam', 'Ana'], values: [] },
    {
      pointer: '/tier',
      label: 'tier',
      samples: ['Blue', 'Gift card', 'Copper'],
      values: [
        { value: 'Blue', count: 5 },
        { value: 'Gift card', count: 3 },
        { value: 'Copper', count: 1 },
      ],
    },
  ],
};
const conn = {
  mapping: {
    name: { from: '/memberName', transform: { kind: 'trim' as const } },
    level: {
      from: '/tier',
      transform: { kind: 'enum' as const, options: { map: { Blue: 'blue' } } },
    },
    legacy: { from: '/legacy' },
  },
  holderEmailField: '',
  voidWhen: [
    { from: '/tier', op: 'in' as const, values: ['Gift card'] },
    { from: '/cancelled', op: 'present' as const },
  ],
};

describe('connection map', () => {
  it('reads the saved mapping and void rules into value rows', () => {
    const state = stateOfConnection(conn, preview, INPUT_SCHEMA);
    const level = state.rows.find((r) => r.target === 'level');
    expect(level?.values).toEqual([
      { value: 'Blue', count: 5, to: 'blue' },
      { value: 'Gift card', count: 3, to: SKIP },
      { value: 'Copper', count: 1, to: 'copper' },
    ]);
  });

  it('writes "Don\'t issue" as a void rule and keeps what the rows do not show', () => {
    const state = stateOfConnection(conn, preview, INPUT_SCHEMA);
    const out = mapOfState(state, conn);
    expect(out.errors).toEqual({});
    expect(out.mapping.legacy).toEqual({ from: '/legacy' });
    expect(out.mapping.name).toEqual({ from: '/memberName', transform: { kind: 'trim' } });
    const map = out.mapping.level?.transform?.options?.map as Record<string, string>;
    expect(map).toEqual({ Blue: 'blue', Copper: 'copper' });
    expect(out.voidWhen).toEqual([
      { from: '/cancelled', op: 'present' },
      { from: '/tier', op: 'in', values: ['Gift card'] },
    ]);
  });

  it('drops the rule once the value gets an option', () => {
    const state = stateOfConnection(conn, preview, INPUT_SCHEMA);
    const rows = state.rows.map((r) =>
      r.target === 'level'
        ? { ...r, values: r.values.map((v) => (v.to === SKIP ? { ...v, to: 'copper' } : v)) }
        : r,
    );
    expect(mapOfState({ ...state, rows }, conn).voidWhen).toEqual([
      { from: '/cancelled', op: 'present' },
    ]);
  });
});
