import { describe, expect, it } from 'vitest';
import { classify, presenceOf, type TargetFacts, type Verdict } from './classify.ts';

const base: TargetFacts = { present: false, grant: false, wanted: false, held: false, seen: false };
const verdict = (f: Partial<TargetFacts>): Verdict => classify({ ...base, ...f });

describe('classify: the owner wins', () => {
  it.each<[string, Partial<TargetFacts>, Verdict]>([
    ['present, ours, wanted', { present: true, grant: true, wanted: true }, 'ok'],
    ['present, ours, unwanted', { present: true, grant: true }, 'remove'],
    ['present without our grant, wanted', { present: true, wanted: true }, 'external'],
    [
      'present again after a hold (the owner put it back)',
      { present: true, grant: true, wanted: true, held: true },
      'external',
    ],
    ['present without our grant, unwanted', { present: true }, 'external'],
    [
      'absent, ours, wanted, seen present before',
      { grant: true, wanted: true, seen: true },
      'hold',
    ],
    ['absent, ours, wanted, never seen', { grant: true, wanted: true }, 'add'],
    [
      'absent, ours, wanted, already held',
      { grant: true, wanted: true, held: true, seen: true },
      'held',
    ],
    ['absent, ours, unwanted', { grant: true, seen: true }, 'settle'],
    ['absent, ours, unwanted, held', { grant: true, held: true }, 'settle'],
    ['absent, no grant, wanted, never seen', { wanted: true }, 'add'],
    [
      'absent, no grant, wanted, seen present (an owner role the owner took)',
      { wanted: true, seen: true },
      'hold',
    ],
    [
      'absent, no grant, wanted, held (grant ended by the owner)',
      { wanted: true, held: true },
      'held',
    ],
    ['absent, no grant, unwanted', {}, 'none'],
  ])('%s', (_name, facts, expected) => expect(verdict(facts)).toBe(expected));

  it('holds a role seen present and wanted whether or not PassBook added it', () => {
    for (const grant of [true, false])
      expect(verdict({ grant, wanted: true, seen: true })).toBe('hold');
  });

  it('never removes a role PassBook did not add, whatever is wanted', () => {
    for (const wanted of [true, false])
      for (const held of [true, false])
        expect(verdict({ present: true, wanted, held })).toBe('external');
  });

  it('never adds a held role', () => {
    for (const grant of [true, false])
      for (const seen of [true, false])
        expect(verdict({ grant, held: true, wanted: true, seen })).toBe('held');
  });

  it('records presence from Polaris ID and the grant', () => {
    expect(presenceOf({ present: true, grant: true })).toBe('passbook');
    expect(presenceOf({ present: true, grant: false })).toBe('external');
    expect(presenceOf({ present: false, grant: true })).toBe('none');
  });
});
