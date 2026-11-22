import type { Actor } from '../passes/service.ts';
import type { BroadcastRow } from './repo.ts';

const ACTOR_TYPES = ['user', 'api_key', 'system', 'connection'] as const;

export function actorOf(row: Pick<BroadcastRow, 'created_by_type' | 'created_by_id'>): Actor {
  const type = ACTOR_TYPES.find((t) => t === row.created_by_type) ?? 'system';
  return { type, id: row.created_by_id };
}
