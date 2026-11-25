import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fieldChanges } from './diff.ts';

const { inputs } = JSON.parse(
  readFileSync('templates/starter-monthly-pass/wallet.template.json', 'utf8'),
) as { inputs: unknown };

const UTC = { timeZone: 'UTC' };
const LA = { timeZone: 'America/Los_Angeles' };

describe('fieldChanges', () => {
  it('labels fields and options and formats dates and numbers', () => {
    const before = {
      memberName: 'Alex',
      plan: 'member',
      validUntil: '2030-01-01T00:00:00Z',
      guests: 2,
    };
    const after = {
      memberName: 'Alex Morgan',
      plan: 'member',
      validUntil: '2031-06-30T00:00:00Z',
      guests: 1200,
    };
    expect(fieldChanges(inputs, before, after, UTC)).toEqual([
      { key: 'memberName', label: 'Name', from: 'Alex', to: 'Alex Morgan' },
      { key: 'validUntil', label: 'Paid through', from: 'Jan 1, 2030', to: 'Jun 30, 2031' },
      { key: 'guests', label: 'Guests left', from: '2', to: '1,200' },
    ]);
  });

  it('shows an option by its label, never its key', () => {
    const [change] = fieldChanges(
      inputs,
      { status: 'Active' },
      { status: 'Suspended', plan: 'member' },
      UTC,
    );
    expect(change).toEqual({ key: 'status', label: 'Status', from: 'Active', to: 'Suspended' });
    expect(fieldChanges(inputs, null, { plan: 'member' }, UTC)).toEqual([
      { key: 'plan', label: 'Plan', from: null, to: 'Monthly' },
    ]);
  });

  it('reads a date stored as midnight UTC as that day in any zone', () => {
    const at = { validUntil: '2030-01-01T00:00:00Z' };
    expect(fieldChanges(inputs, {}, at, LA)[0]?.to).toBe('Jan 1, 2030');
    expect(fieldChanges(inputs, {}, { validUntil: '2030-01-01T00:00:00.000Z' }, LA)[0]?.to).toBe(
      'Jan 1, 2030',
    );
  });

  it('adds the time of day only when there is one', () => {
    const at = { validUntil: '2030-01-01T13:45:00Z' };
    expect(fieldChanges(inputs, {}, at, UTC)[0]?.to).toBe('Jan 1, 2030, 1:45 PM');
    // The time reads in the zone given.
    expect(fieldChanges(inputs, {}, at, LA)[0]?.to).toBe('Jan 1, 2030, 5:45 AM');
  });

  it('reads a calendar day the same in any zone', () => {
    const [c] = fieldChanges(inputs, {}, { validUntil: '2030-01-01' }, LA);
    expect(c?.to).toBe('Jan 1, 2030');
  });

  it('skips unchanged, empty-to-empty, rewritten and undeclared values', () => {
    expect(
      fieldChanges(
        inputs,
        { note: '', validUntil: '2030-01-01T00:00:00Z', extra: 1 },
        { note: null, validUntil: '2030-01-01T00:00:00.000Z', extra: 2 },
        UTC,
      ),
    ).toEqual([]);
  });

  it('reports a cleared value as empty', () => {
    expect(fieldChanges(inputs, { message: 'Hi' }, { message: '' }, UTC)).toEqual([
      { key: 'message', label: 'Message', from: 'Hi', to: null },
    ]);
  });
});
