import { describe, expect, it } from 'vitest';
import { where } from './repo-feed-scope.ts';

describe('feed filter SQL', () => {
  it('leaves the org and mode to the fence and binds every filter value in order', () => {
    const filter = where({
      mode: 'live',
      orgId: 'org-1',
      scannerId: 'scanner-1',
      staffId: 'staff-1',
      eventId: 'event-1',
      passId: 'pass-1',
      outcome: 'ok',
      reason: 'voided',
      from: 10,
      to: 20,
      limit: 10,
    });
    expect(filter.sql).not.toMatch(/s\.(org_id|mode) = \?/);
    expect(filter.params).toEqual([
      'scanner-1',
      'staff-1',
      'event-1',
      'pass-1',
      'ok',
      'voided',
      10,
      20,
    ]);
  });

  it('continues only from a decoded position, never from a raw row id', () => {
    const raw = where({ mode: 'live', orgId: 'org-1', cursor: 'raw-row-id', limit: 10 });
    expect(raw.params).toEqual([]);
    const decoded = where({
      mode: 'live',
      orgId: 'org-1',
      limit: 10,
      internalCursor: { at: 42, id: 'scan-9' },
    });
    expect(decoded.params).toEqual([42, 'scan-9']);
    expect(decoded.sql).toContain('(s.at, s.id) < (?, ?');
  });

  it('keeps a pass search to the exact pass id', () => {
    expect(where({ mode: 'live', q: 'pass-1', limit: 10 }).params).toEqual(['pass-1']);
  });
});
