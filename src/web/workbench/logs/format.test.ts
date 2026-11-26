import { describe, expect, it } from 'vitest';
import { clock, count, flavour } from './format.ts';
import { duration, pathParts } from './row-format.ts';

const text = (runs: { text: string }[]) => runs.map((r) => r.text).join('');

describe('log formatting', () => {
  it('shows the time with seconds today and the date before', () => {
    const now = new Date(2026, 10, 20, 15, 0, 0).getTime();
    expect(clock(new Date(2026, 10, 20, 9, 5, 7).getTime(), now)).toBe('09:05:07');
    expect(clock(new Date(2026, 10, 19, 14, 2, 11).getTime(), now)).toBe('Nov 19 14:02');
  });

  it('groups thousands and tones a status', () => {
    expect(count(0)).toBe('0');
    expect(count(1234567)).toBe('1,234,567');
    expect([200, 302, 404, 503].map(flavour)).toEqual(['success', 'info', 'warning', 'danger']);
  });

  it('reads a duration in ms, then seconds', () => {
    expect([0, 24, 999, 2400, 12_345].map(duration)).toEqual([
      '0 ms',
      '24 ms',
      '999 ms',
      '2.4 s',
      '12 s',
    ]);
  });
});

describe('a path for one line', () => {
  it('drops /api/v1, keeps the query, and always shows the last segment', () => {
    const p = pathParts('/api/v1/passes/p1', 'a=1');
    expect(p.full).toBe('/passes/p1?a=1');
    expect(text(p.head)).toBe('/passes');
    expect(text(p.tail)).toBe('/p1?a=1');
    expect(pathParts('/api/v1', null).full).toBe('/');
  });

  it('dims ids so the resource names lead', () => {
    const p = pathParts('/api/v1/passes/01a21159-eb6a-7557-b7b0-72729cb2ca70/void', null);
    expect(p.head.filter((r) => r.id).map((r) => r.text)).toEqual([
      '01a21159-eb6a-7557-b7b0-72729cb2ca70',
    ]);
    expect(p.head.find((r) => r.text.includes('passes'))?.id).toBe(false);
    expect(text(p.tail)).toBe('/void');
    expect(pathParts('/api/v1/webhook-endpoints', null).head.some((r) => r.id)).toBe(false);
  });

  it('keeps only the query in the tail when the last segment is long, and no tail when both are', () => {
    const id = '01a21159-eb6a-7557-b7b0-72729cb2ca70';
    expect(pathParts(`/api/v1/passes/${id}`, null).tail).toEqual([]);
    expect(text(pathParts(`/api/v1/passes/${id}/void`, null).tail)).toBe('/void');
    expect(text(pathParts(`/api/v1/passes/${id}`, 'expand=holder').tail)).toBe('?expand=holder');
    const long = pathParts(`/api/v1/passes/${id}`, `templateId=${id}&limit=50`);
    expect(long.tail).toEqual([]);
    expect(text(long.head)).toBe(long.full);
  });
});
