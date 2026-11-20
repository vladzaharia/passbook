import { describe, expect, it } from 'vitest';
import type { EntryRule } from '@/shared/contracts/template-releases.ts';
import { capNote, ruleWords } from './admits-rules.tsx';

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

describe('capNote', () => {
  it('warns only when the session cap is stricter than the type', () => {
    expect(capNote(rule(), { mode: 'single' })).toBe('Session cap: one scan per pass');
    expect(capNote(rule({ mode: 'single' }), { mode: 'daily' })).toBeNull();
    expect(capNote(rule(), {})).toBeNull();
    expect(capNote(rule(), { mode: 'in_out' })).toBeNull();
  });
});
