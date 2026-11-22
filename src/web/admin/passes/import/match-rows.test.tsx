import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MatchRow, MatchState } from './match-model.ts';
import { MatchRows } from './match-rows.tsx';

const row = (key: string, over: Partial<MatchRow> = {}): MatchRow =>
  ({
    key,
    role: 'field',
    target: key,
    label: key,
    required: false,
    hasDefault: false,
    kind: 'text',
    options: [],
    from: [],
    confidence: null,
    values: [],
    date: null,
    dateOutput: 'date',
    counted: true,
    ...over,
  }) as MatchRow;

const state = (rows: MatchRow[]): MatchState => ({ rows, unused: [], find: 'none' });
const cols = [{ pointer: '/a', label: 'A', samples: ['x'] }] as never;

describe('MatchRows', () => {
  it('folds optional fields with no column once there are more than three', () => {
    const rows = [
      row('name', { from: ['/a'], required: true }),
      ...['f1', 'f2', 'f3', 'f4'].map((k) => row(k)),
    ];
    const { container } = render(
      <MatchRows rows={rows} columns={cols} state={state(rows)} errors={{}} onRow={() => {}} />,
    );
    expect(screen.getByText('4 fields with no column')).toBeInTheDocument();
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('keeps a few unmapped fields in the list', () => {
    const rows = [row('name', { from: ['/a'] }), row('f1'), row('f2')];
    const { container } = render(
      <MatchRows rows={rows} columns={cols} state={state(rows)} errors={{}} onRow={() => {}} />,
    );
    expect(container.querySelector('details')).toBeNull();
  });

  it('opens the fold when a folded field has an error', () => {
    const rows = ['f1', 'f2', 'f3', 'f4'].map((k) => row(k));
    const { container } = render(
      <MatchRows
        rows={rows}
        columns={cols}
        state={state(rows)}
        errors={{ f2: 'Bad.' }}
        onRow={() => {}}
      />,
    );
    expect(container.querySelector('details')?.open).toBe(true);
  });
});
