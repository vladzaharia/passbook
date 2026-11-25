import { IdpError } from './types.ts';

const LEASE_MS = 60_000;

/**
 * One change per account at a time. The lease is taken before the first Polaris ID read and released after
 * the read-back, so two calls cannot interleave their read-modify-write of one user's groups. A held lease is
 * `IDP_CONFLICT`; one past its time (a crashed holder) is taken over.
 */
export async function withLock<T>(
  db: D1Database,
  subject: string,
  now: () => number,
  fn: () => Promise<T>,
): Promise<T> {
  const token = crypto.randomUUID();
  const at = now();
  const res = await db
    .prepare(
      `INSERT INTO idp_locks (subject, call_id, until) VALUES (?1, ?2, ?3)
       ON CONFLICT (subject) DO UPDATE SET call_id = ?2, until = ?3 WHERE idp_locks.until < ?4`,
    )
    .bind(subject, token, at + LEASE_MS, at)
    .run();
  if (res.meta.changes !== 1)
    throw new IdpError('IDP_CONFLICT', 'Another change to this account is running.');
  try {
    return await fn();
  } finally {
    await db
      .prepare('DELETE FROM idp_locks WHERE subject = ? AND call_id = ?')
      .bind(subject, token)
      .run();
  }
}
