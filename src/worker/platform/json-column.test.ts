import { describe, expect, it } from 'vitest';
import { parseJsonArray, parseRoles } from './json-column.ts';
import { createLogger } from './log.ts';

describe('parseJsonArray', () => {
  it('keeps accepted items', () => {
    expect(parseRoles('["admin","x","user"]')).toEqual(['admin', 'user']);
  });

  it('returns nothing and logs a stable code for corrupt values', () => {
    const lines: string[] = [];
    const log = createLogger({}, { sink: (line) => lines.push(line) });
    const isString = (v: unknown): v is string => typeof v === 'string';
    expect(parseJsonArray('{nope', 'groups', isString, log)).toEqual([]);
    expect(parseJsonArray('{"a":1}', 'groups', isString, log)).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('JSON_COLUMN_CORRUPT');
    expect(lines[0]).toContain('groups');
  });
});
