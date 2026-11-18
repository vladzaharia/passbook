import type { Context } from 'hono';
import type { ScanActor } from './actor.ts';
import { replayScanByKeyStmt } from './repo-act-authority.ts';
import { replayRow } from './repo-tags-bind.ts';

/**
 * A retry of an action this device already committed answers with its stored result, even after the
 * session closed: the door must not tell a guest the ledger admitted that scanning is closed.
 */
export async function retriesCommitted(
  c: Context,
  db: D1Database,
  actor: ScanActor,
): Promise<boolean> {
  const action = c.req.path.endsWith('/actions');
  if (!action && !c.req.path.endsWith('/tags/bind')) return false;
  // A body that is not JSON has no key: it is refused as closed, and validation answers it later.
  const body = (await c.req.json().catch(() => null)) as {
    idempotencyKey?: unknown;
    preview?: unknown;
  } | null;
  const key = body?.idempotencyKey;
  // A preview writes nothing: closed refuses it like the assign itself.
  if (typeof key !== 'string' || body?.preview === true) return false;
  if (!action) return !!actor.scanner && !!(await replayRow(db, actor.scanner.id, key));
  const row = await replayScanByKeyStmt(db, actor.actorKey, key).first<{ state: string }>();
  return row?.state === 'done';
}
