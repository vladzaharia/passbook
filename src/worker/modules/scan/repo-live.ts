import { first } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';

export function liveCredentialKeyset(db: D1Database, keyset: string) {
  return first<{ current: number }>(db, `SELECT 1 AS current WHERE ${credentialRefKeysetSql}`, [
    keyset,
  ]);
}
