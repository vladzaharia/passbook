import { describe, expect, it } from 'vitest';
import { scopeAnd } from './scope.ts';

describe('scopeAnd', () => {
  it('adds no filter for a platform-wide caller', () => {
    expect(scopeAnd(null)).toEqual({ sql: '', params: [] });
  });

  it('filters by org, and by mode only for an API key', () => {
    expect(scopeAnd('o1', 'p')).toEqual({ sql: ' AND p.org_id = ?', params: ['o1'] });
    expect(scopeAnd({ orgId: 'o1', mode: 'test', principal: 'session' })).toEqual({
      sql: ' AND org_id = ?',
      params: ['o1'],
    });
    expect(scopeAnd({ orgId: 'o1', mode: 'test', principal: 'api_key' }, 'p')).toEqual({
      sql: ' AND p.org_id = ? AND p.mode = ?',
      params: ['o1', 'test'],
    });
  });
});
