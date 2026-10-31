import type { Envelope } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';

export interface PersonalizationRow {
  passId: string;
  tokenSha256: string;
  publishedAt: number | null;
}

export async function getPersonalization(
  db: D1Database,
  passId: string,
): Promise<PersonalizationRow | null> {
  const row = await first<{ pass_id: string; token_sha256: string; published_at: number | null }>(
    db,
    'SELECT pass_id, token_sha256, published_at FROM pass_personalizations WHERE pass_id = ?',
    [passId],
  );
  return row
    ? { passId: row.pass_id, tokenSha256: row.token_sha256, publishedAt: row.published_at }
    : null;
}

export async function isPersonalized(db: D1Database, passId: string): Promise<boolean> {
  return (await getPersonalization(db, passId)) !== null;
}

/** Returns false when a concurrent request stored one first. */
export async function insertPersonalization(
  db: D1Database,
  r: { passId: string; tokenSha256: string; envelope: Envelope; now: number },
): Promise<boolean> {
  const result = await run(
    db,
    `INSERT OR IGNORE INTO pass_personalizations
       (pass_id, token_sha256, kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      r.passId,
      r.tokenSha256,
      r.envelope.kekVersion,
      r.envelope.iv,
      r.envelope.wrappedDek,
      r.envelope.ciphertext,
      r.now,
    ],
  );
  return result.changes > 0;
}

export async function markPersonalizationPublished(
  db: D1Database,
  passId: string,
  now: number,
): Promise<void> {
  await run(db, 'UPDATE pass_personalizations SET published_at = ? WHERE pass_id = ?', [
    now,
    passId,
  ]);
}
