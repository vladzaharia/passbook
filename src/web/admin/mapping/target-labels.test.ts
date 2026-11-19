import { describe, expect, it } from 'vitest';
import { humanizeKey, targetsOf } from './mapping-editor.tsx';

describe('template field labels', () => {
  it('turns an unlabelled key into a sentence-case label', () => {
    expect(humanizeKey('points')).toBe('Points');
    expect(humanizeKey('guestsLeft')).toBe('Guests left');
    expect(humanizeKey('member_id')).toBe('Member id');
  });
  it('keeps an explicit label as written', () => {
    const [t, u] = targetsOf([
      { key: 'memberId', label: 'ID', required: true },
      { key: 'points', label: 'points', required: false },
    ]);
    expect(t?.label).toBe('ID');
    expect(u?.label).toBe('Points');
  });
});
