import type { Context } from 'hono';
import type { ScanActor } from './actor.ts';
import { replayScanByKeyStmt } from './repo-act-authority.ts';

/**
 * A retry of an action this device already committed answers with its stored result, even after the
 * session closed: the door must not tell a guest the ledger admitted that scanning is closed.
 */
export async function retriesCommitted(
  c: Context,
  db: D1Database,
  actor: ScanActor,
): Promise<boolean> {
  if (!c.req.path.endsWith('/actions')) return false;
  // A body that is not JSON has no key: it is refused as closed, and validation answers it later.
  const body = (await c.req.json().catch(() => null)) as { idempotencyKey?: unknown } | null;
  const key = body?.idempotencyKey;
  if (typeof key !== 'string') return false;
  const row = await replayScanByKeyStmt(db, actor.actorKey, key).first<{ state: string }>();
  return row?.state === 'done';
}
