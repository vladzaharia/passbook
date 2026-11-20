import { describe, expect, it } from 'vitest';
import type { EntryRule } from '@/shared/contracts/template-releases.ts';
import { capNotes, ruleWords } from './admits-rules.tsx';

const rule = (over: Partial<EntryRule> = {}): EntryRule => ({
  mode: 'unlimited',
  days: null,
  durationMinutes: null,
  durationFrom: null,
  plans: [],
  source: 'template',
  ...over,
});

describe('ruleWords', () => {
  it('words the mode, the day limit and the plan kinds', () => {
    expect(ruleWords(rule())).toBe('Every visit');
    expect(ruleWords(rule({ days: 1, durationFrom: 'first_scan' }))).toBe(
      'Every visit · all day from first scan',
    );
    expect(
      ruleWords(rule({ mode: 'single', days: 3, durationFrom: 'issued', plans: ['guest'] })),
    ).toBe('One scan per pass · 3 days from issue · guest plan');
    expect(ruleWords(rule({ mode: 'daily', durationMinutes: 90 }))).toBe(
      'Once a day · 90 min from first scan',
    );
  });
});

describe('capNotes', () => {
  it('ranks the session mode as admission does', () => {
    expect(capNotes(rule(), { mode: 'single' })).toEqual(['Session cap: one scan per pass']);
    expect(capNotes(rule(), { mode: 'in_out' })).toEqual(['Session cap: track in / out']);
    expect(capNotes(rule({ mode: 'daily' }), { mode: 'in_out' })).toEqual([
      'Session cap: track in / out',
    ]);
    expect(capNotes(rule({ mode: 'single' }), { mode: 'in_out' })).toEqual([]);
    expect(capNotes(rule({ mode: 'single' }), { mode: 'daily' })).toEqual([]);
    expect(capNotes(rule(), {})).toEqual([]);
  });

  it('shows a cap that shortens the validity, never one that lengthens it', () => {
    const day = rule({ days: 3, durationFrom: 'issued' });
    expect(capNotes(day, { days: 1 })).toEqual(['Session cap: all day from issue']);
    expect(capNotes(day, { days: 5 })).toEqual([]);
    expect(capNotes(rule(), { days: 2 })).toEqual(['Session cap: 2 days from first scan']);
    expect(capNotes(rule({ durationMinutes: 90 }), { durationMinutes: 60 })).toEqual([
      'Session cap: 60 min from first scan',
    ]);
    expect(capNotes(rule({ durationMinutes: 30 }), { durationMinutes: 60 })).toEqual([]);
  });
});
