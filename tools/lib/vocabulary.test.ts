import { describe, expect, it } from 'vitest';
import { vocabularyFailures } from './vocabulary.ts';

const names = { 'passes.getX': { resource: 'passes', method: 'retrieve' } };

describe('vocabularyFailures', () => {
  it('accepts a clean name and description', () => {
    expect(vocabularyFailures(names, { 'passes.getX': 'One pass, in color.' })).toEqual([]);
  });

  it('rejects an unreviewed verb and a UK spelling', () => {
    const out = vocabularyFailures(
      { 'a.b': { resource: 'walletEnrolments', method: 'expire2' } },
      { 'a.b': 'Sets the colour.' },
    );
    expect(out).toHaveLength(3);
  });

  it('rejects a description that is not a sentence', () => {
    expect(vocabularyFailures(names, { 'passes.getX': 'one pass' })).toHaveLength(2);
  });
});
