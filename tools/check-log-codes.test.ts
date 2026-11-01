import { describe, expect, it } from 'vitest';
import { findUncodedLogs } from './check-log-codes.ts';

describe('findUncodedLogs', () => {
  it('flags warn and error calls without a code or error', () => {
    const text = [
      "ctx.log.warn('a', { orgId });",
      "ctx.log.error('b');",
      "log?.warn('c', { code: 'X' });",
      "base.log.error('d', { error });",
      "ctx.log.info('e', { orgId });",
      "ctx.log.warn('f', data);",
    ].join('\n');
    expect(findUncodedLogs('/x.ts', text).map((s) => s.slice(s.lastIndexOf(':')))).toEqual([
      ':1',
      ':2',
    ]);
  });
});
