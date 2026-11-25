import { run } from '../../platform/db.ts';

/** The one lease the drain, the reconcile and Check now share, so two runs never overlap. */
export const SYNC_LEASE = 'idp-sync';
/** A run that dies frees the lease after this long. */
export const LEASE_TTL_MS = 300_000;

/** Takes the lease unless another holder's is still live. True when this holder has it. */
export async function takeLease(
  db: D1Database,
  name: string,
  holder: string,
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `INSERT INTO idp_run_lease (name, holder, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
     WHERE idp_run_lease.expires_at <= ?`,
    [name, holder, now + LEASE_TTL_MS, now],
  );
  return changes > 0;
}

/** Frees the lease if this holder still has it. */
export async function dropLease(db: D1Database, name: string, holder: string): Promise<void> {
  await run(db, 'DELETE FROM idp_run_lease WHERE name = ? AND holder = ?', [name, holder]);
}

/** Pushes this holder's expiry out again; false when the lease is no longer theirs. */
export async function renewLease(
  db: D1Database,
  name: string,
  holder: string,
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    'UPDATE idp_run_lease SET expires_at = ? WHERE name = ? AND holder = ?',
    [now + LEASE_TTL_MS, name, holder],
  );
  return changes > 0;
}
