import type {
  BroadcastCounts,
  BroadcastDto,
  BroadcastTarget,
} from '../../../shared/contracts/broadcasts.ts';
import type { BroadcastRow, CountRow } from './repo.ts';

export function countsOf(row: BroadcastRow, items: readonly CountRow[]): BroadcastCounts {
  const counts: BroadcastCounts = {
    targeted: row.targeted,
    updated: 0,
    unchanged: 0,
    overBudget: 0,
    failed: 0,
  };
  for (const item of items) {
    if (item.broadcast_id !== row.id) continue;
    counts[item.outcome] += item.n;
    if (item.outcome === 'updated' && item.silent === 1) counts.overBudget += item.n;
  }
  return counts;
}

export function toDto(
  row: BroadcastRow,
  items: readonly CountRow[],
  followUps: readonly { id: string; parent_id: string; at: number | null }[] = [],
): BroadcastDto {
  const followUp = followUps.find((f) => f.parent_id === row.id);
  return {
    id: row.id,
    orgId: row.org_id,
    mode: row.mode,
    kind: row.kind,
    name: row.name,
    state: row.state,
    target: JSON.parse(row.target) as BroadcastTarget,
    patch: JSON.parse(row.patch) as BroadcastDto['patch'],
    notify: row.notify === 1,
    at: row.at,
    clearAfter: row.clear_after,
    parentId: row.parent_id,
    followUp: followUp ? { id: followUp.id, at: followUp.at } : null,
    counts: countsOf(row, items),
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
