import { describe, expect, it } from 'vitest';
import { where } from './repo-feed-scope.ts';
import { packScanPredicate } from './repo-secret-binds.ts';

describe('feed filter SQL secret bindings', () => {
  it('keeps relation, pass, search and continuation IDs out of packed metadata', () => {
    const sensitive = [
      'scanner-private-710',
      'staff-private-711',
      'event-private-712',
      'pass-private-713',
      'query-private-714',
      'cursor-private-715',
      'reason-private-716',
    ];
    const [scannerId, staffId, eventId, passId, q, cursor, reason] = sensitive;
    const filter = where(
      {
        mode: 'live',
        orgId: 'org-1',
        scannerId,
        staffId,
        eventId,
        passId,
        q,
        cursor,
        reason,
        limit: 10,
      },
      1_800_000_000_000,
    );
    const packed = packScanPredicate(filter.sql, filter.params, 'feed_filter_snapshot');
    expect(packed).not.toBeNull();
    if (!packed) throw new Error('The feed filter must be packable.');
    const metadata = String(packed.params[0]);
    for (const value of sensitive) {
      expect(metadata).not.toContain(value);
      expect(packed.params.slice(1)).toContain(value);
    }
  });

  it('keeps opaque internal continuation IDs in scalar binds', () => {
    const filter = where(
      {
        mode: 'live',
        orgId: 'org-1',
        limit: 10,
        internalCursor: { at: 42, id: 'internal-cursor-private' },
      },
      1_800_000_000_000,
    );
    const packed = packScanPredicate(filter.sql, filter.params, 'feed_cursor_snapshot');
    expect(packed).not.toBeNull();
    if (!packed) throw new Error('The feed cursor must be packable.');
    expect(String(packed.params[0])).not.toContain('internal-cursor-private');
    expect(packed.params.slice(1)).toContain('internal-cursor-private');
  });
});
