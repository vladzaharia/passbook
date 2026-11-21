import { describe, expect, it } from 'vitest';
import { timelineEntries } from './release-timeline.tsx';
import { release } from './test-fixtures.tsx';

describe('timelineEntries', () => {
  it('joins a Test release made with the Live one and lists a Try alone', () => {
    const live = release({ id: 'l1', createdAt: 5_000_000 });
    const withLive = release({ id: 't1', mode: 'test', createdAt: 5_000_500 });
    const tried = release({ id: 't2', mode: 'test', version: 'version-2', createdAt: 9_000_000 });
    const rows = timelineEntries([live], [withLive, tried]);
    expect(rows.map((r) => [r.live?.id ?? null, r.test?.id ?? null])).toEqual([
      [null, 't2'],
      ['l1', 't1'],
    ]);
  });

  it('does not join a Test release of another version or a much later one', () => {
    const live = release({ id: 'l1', createdAt: 1_000_000 });
    const other = release({ id: 't1', mode: 'test', version: 'version-2', createdAt: 1_000_100 });
    const late = release({ id: 't2', mode: 'test', createdAt: 9_000_000 });
    const rows = timelineEntries([live], [other, late]);
    expect(rows.find((r) => r.live)?.test).toBeNull();
    expect(rows).toHaveLength(3);
  });
});
