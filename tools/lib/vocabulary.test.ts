import { describe, expect, it } from 'vitest';
import { proseFailures, ukSpelling, vocabularyFailures } from './vocabulary.ts';

const names = { 'passes.getX': { resource: 'passes', method: 'retrieve' } };

describe('vocabularyFailures', () => {
  it('accepts a clean name and description', () => {
    expect(vocabularyFailures(names, { 'passes.getX': 'One pass, in color.' })).toEqual([]);
  });

  it('accepts a noun prefix that has a rule, and a reviewed verb', () => {
    const n = {
      'a.b': { resource: 'passes', method: 'bulkReissue' },
      'a.c': { resource: 'x', method: 'share' },
    };
    expect(vocabularyFailures(n, {})).toEqual([]);
  });

  it('names the unreviewed verb', () => {
    expect(vocabularyFailures({ 'a.b': { resource: 'passes', method: 'expire2' } }, {})).toEqual([
      'a.b: method expire2 starts with "expire"; add it to METHOD_VERBS or NOUN_PREFIXES',
    ]);
  });

  it('names the UK spelling in an SDK name, split by camelCase', () => {
    expect(
      vocabularyFailures({ 'a.b': { resource: 'walletEnrolments', method: 'list' } }, {}),
    ).toEqual(['a.b: the SDK name has the UK spelling "Enrolments"; use the US spelling']);
  });

  it('names the sentence-form rule that a description breaks', () => {
    expect(vocabularyFailures(names, { 'passes.getX': 'one pass' })).toEqual([
      'passes.getX: a description must start with a capital letter or a backtick',
      'passes.getX: a description must end with a period or a closing mark',
    ]);
    expect(vocabularyFailures(names, { 'passes.getX': 'One pass (live).' })).toEqual([]);
  });
});

describe('ukSpelling', () => {
  it.each([
    'colour',
    'labelled',
    'cancelled',
    'personalised',
    'organisation',
    'enrolment',
    'analyse',
    'whilst',
  ])('finds %s', (word) => expect(ukSpelling(`The ${word} is set.`)).toBe(word));

  it.each([
    'color',
    'labeled',
    'canceled',
    'personalized',
    'organization',
    'enrollment',
    'cancellation',
    'enroll',
  ])('accepts %s', (word) => expect(ukSpelling(`The ${word} is set.`)).toBeUndefined());

  it('matches whole words, and skips code spans (wire values)', () => {
    expect(ukSpelling('Greyhound Centre Street')).toBe('Centre');
    expect(ukSpelling('Greyhound')).toBeUndefined();
    expect(ukSpelling('A run ends `cancelled`.')).toBeUndefined();
  });
});

describe('proseFailures', () => {
  it('reads summaries and descriptions of paths and components, not enum values', () => {
    const doc = {
      paths: { '/a': { get: { summary: 'Set the colour' } } },
      components: { schemas: { S: { description: 'An enrolment', enum: ['cancelled'] } } },
    };
    expect(proseFailures(doc)).toEqual([
      'paths./a.get.summary: the text has the UK spelling "colour"; use the US spelling',
      'components.schemas.S.description: the text has the UK spelling "enrolment"; use the US spelling',
    ]);
  });
});
