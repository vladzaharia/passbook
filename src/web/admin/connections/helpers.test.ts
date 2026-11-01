import { describe, expect, it } from 'vitest';
import { connection } from '../passes/test-fixtures.ts';
import { flattenSchema, flattenValues, nestValues, secretKeysFor } from './config-schema.ts';
import { healthLine, healthSentence, overdue } from './health-text.ts';
import { autoMap, blankRow, previewValue } from './mapping.ts';

const NOW = new Date('2026-11-01T04:03:00').getTime();
const c = (over: Record<string, unknown> = {}) => connection(over) as never;

describe('health text', () => {
  it('reads failures and the retry time in one muted line', () => {
    expect(healthLine(c({ consecutiveFailures: 1, nextRunAt: NOW + 60_000 }), NOW)).toBe(
      '1 failure · retries at 4:04 AM',
    );
    expect(healthLine(c({ enabled: false }), NOW)).toBeNull();
  });

  it('opens the health card with a sentence', () => {
    expect(
      healthSentence(
        c({ consecutiveFailures: 1, lastErrorAt: NOW - 60_000, nextRunAt: NOW + 60_000 }),
        NOW,
      ),
    ).toBe('Failing since 4:02 AM · 1 failure in a row · next retry in 1 min');
    expect(
      healthSentence(c({ consecutiveFailures: 0, lastSuccessAt: NOW, nextRunAt: null }), NOW),
    ).toBe('Synced 4:03 AM');
  });

  it('flags a run that is more than a minute late', () => {
    expect(overdue(c({ nextRunAt: NOW - 120_000 }), NOW)).toBe(true);
    expect(overdue(c({ nextRunAt: NOW + 1 }), NOW)).toBe(false);
  });
});

describe('config schema', () => {
  const schema = {
    type: 'object',
    required: ['baseUrl'],
    properties: {
      baseUrl: { type: 'string' },
      list: {
        type: 'object',
        'x-label': 'List endpoint',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    },
  };

  it('flattens nested objects into grouped dotted keys', () => {
    const flat = flattenSchema(schema) as {
      properties: Record<string, object>;
      required: string[];
    };
    expect(Object.keys(flat.properties)).toEqual(['baseUrl', 'list.path']);
    expect(flat.properties['list.path']).toMatchObject({ 'x-group': 'List endpoint' });
    expect(flat.required).toEqual(['baseUrl']);
  });

  it('round-trips values and drops empty optional groups', () => {
    expect(flattenValues({ a: 1, auth: { type: 'bearer' } })).toEqual({
      a: 1,
      'auth.type': 'bearer',
    });
    expect(nestValues({ a: 1, 'auth.type': 'bearer', 'list.path': '' })).toEqual({
      a: 1,
      auth: { type: 'bearer' },
    });
  });

  it('hides secrets of other auth types', () => {
    const secrets = {
      properties: { token: { 'x-auth': ['bearer'] }, username: { 'x-auth': ['basic'] }, x: {} },
    };
    expect([...secretKeysFor(secrets, 'bearer')]).toEqual(['username']);
  });
});

describe('mapping helpers', () => {
  const targets = [
    { key: 'holder', label: 'Name', required: true },
    { key: 'memberId', label: 'ID', required: true },
    { key: 'tier', label: 'Tier', required: false, values: ['Standard', 'Plus', 'Pro'] },
    { key: 'points', label: 'Points', required: false },
  ];
  const sources = [
    { pointer: '/memberName', preview: 'Maya Chen' },
    { pointer: '/memberId', preview: 'm-001' },
    { pointer: '/tier', preview: 'Gold' },
    { pointer: '/points', preview: '120' },
  ];

  it('auto-maps holder, memberId and points; skips enum values the template refuses', () => {
    const rows = autoMap([], targets, sources);
    expect(rows.map((r) => [r.input, r.from])).toEqual([
      ['holder', '/memberName'],
      ['memberId', '/memberId'],
      ['points', '/points'],
    ]);
  });

  it('previews the sample through the transform', () => {
    const row = { ...blankRow(), input: 'holder', from: '/memberName', kind: 'upper' as const };
    expect(previewValue(row, sources)).toBe('MAYA CHEN');
    expect(previewValue({ ...row, kind: 'constant', options: '{"value": 3}' }, sources)).toBe('3');
  });
});
