import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ReleaseDiff } from './release-diff.tsx';

const text = (t: string) => ({ type: 'text' as const, text: t });
const groups = [
  {
    group: 'colors' as const,
    rows: [
      {
        label: 'Background',
        kind: 'added' as const,
        from: null,
        to: { type: 'color' as const, color: 'rgb(20,26,43)' },
      },
    ],
    more: 0,
  },
  {
    group: 'front' as const,
    rows: [
      { label: 'Since', kind: 'added' as const, from: null, to: text('2026-01-01T00:00:00Z') },
    ],
    more: 0,
  },
  {
    group: 'back' as const,
    rows: [
      { label: 'Back: Note', kind: 'added' as const, from: null, to: text('') },
      { label: 'Back: Terms', kind: 'added' as const, from: null, to: text('Show the code.') },
    ],
    more: 0,
  },
];

it('lists a colour as a hex, a date as a day, and leaves out added fields with no value', () => {
  render(<ReleaseDiff groups={groups} image={() => ''} />);
  expect(screen.getByText('#141A2B')).toBeInTheDocument();
  expect(screen.getByText('Jan 1, 2026')).toBeInTheDocument();
  expect(screen.getByText('Show the code.')).toBeInTheDocument();
  expect(screen.queryByText('Back: Note')).toBeNull();
});
