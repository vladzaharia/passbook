import { logRefusal, type Meta } from './ledger.ts';
import { IdpError } from './types.ts';

/** True while a freeze row has no `thawed_at`. Nothing in this Worker sets `thawed_at`: only the owner's D1 command does. */
export async function isFrozen(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS f FROM idp_freezes WHERE thawed_at IS NULL LIMIT 1')
    .first();
  return row !== null;
}

/** Every write passes here first. A frozen binding answers `IDP_FROZEN` before any Polaris ID request. */
export async function assertNotFrozen(db: D1Database, meta: Meta, at: number): Promise<void> {
  if (!(await isFrozen(db))) return;
  await logRefusal(db, meta, at, 'IDP_FROZEN');
  throw new IdpError('IDP_FROZEN', 'Polaris ID changes are paused.');
}

/** Pauses writes. Idempotent; there is deliberately no counterpart. */
export async function writeFreeze(
  db: D1Database,
  reason: string,
  actor: string,
  at: number,
): Promise<'frozen' | 'already'> {
  const res = await db
    .prepare(
      `INSERT INTO idp_freezes (at, reason, actor)
       SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM idp_freezes WHERE thawed_at IS NULL)`,
    )
    .bind(at, reason, actor)
    .run();
  return res.meta.changes === 1 ? 'frozen' : 'already';
}
