import { describe, expect, it } from 'vitest';
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import { fixtureDisplay } from '../machine/fixtures.test-support.ts';
import { keyFactOf } from './key-fact.tsx';

const withRows = (rows: ScanDisplay['panels'][number]['rows']): ScanDisplay => {
  const d = fixtureDisplay('ok');
  const panel = d.panels[0];
  if (!panel) throw new Error('fixture has a panel');
  return { ...d, panels: [{ ...panel, title: 'Gala access', rows }] };
};
const field = {
  type: 'field' as const,
  id: 'f',
  label: 'Ticket',
  value: 'GA',
  icon: null,
  strong: false,
};
const big = {
  type: 'big' as const,
  id: 'b',
  label: null,
  value: '104 · F · 12',
  unit: null,
  tone: 'teal' as const,
};

describe('the glance key fact', () => {
  it('takes the first seat, balance or stamps row, labelled by its panel', () => {
    const fact = keyFactOf(withRows([field, big]));
    expect(fact?.row.type).toBe('big');
    expect(fact?.label).toBe('Gala access');
  });
  it('prefers the row own label', () => {
    expect(keyFactOf(withRows([{ ...big, label: 'Seat' }]))?.label).toBe('Seat');
  });
  it('is none when the panel has only plain fields, or there is no display', () => {
    expect(keyFactOf(withRows([field]))).toBeNull();
    expect(keyFactOf(null)).toBeNull();
  });
  it('reads a stamp card as its progress row', () => {
    expect(keyFactOf(fixtureDisplay('ok'))?.row.type).toBe('progress');
  });
});
