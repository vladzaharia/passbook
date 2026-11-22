import {
  type BroadcastCounts,
  type BroadcastDto,
  BroadcastTargetSchema,
} from '../../../shared/contracts/broadcasts.ts';
import type { BroadcastRow, CountRow } from './repo.ts';
import { StoredBroadcastTargetSchema } from './stored-target.ts';

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

/** A change run's lock-screen text, kept in its stored target. */
function messageOf(row: BroadcastRow): string | null {
  if (row.kind !== 'change') return null;
  const parsed = StoredBroadcastTargetSchema.pick({ message: true }).safeParse(
    JSON.parse(row.target),
  );
  return parsed.success ? (parsed.data.message ?? null) : null;
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
    // The public schema drops what only the server sets (window, sentBy).
    target: BroadcastTargetSchema.parse(JSON.parse(row.target)),
    patch: JSON.parse(row.patch) as BroadcastDto['patch'],
    notify: row.notify === 1,
    at: row.at,
    clearAfter: row.clear_after,
    parentId: row.parent_id,
    message: messageOf(row),
    ruleId: row.rule_id,
    followUp: followUp ? { id: followUp.id, at: followUp.at } : null,
    counts: countsOf(row, items),
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
