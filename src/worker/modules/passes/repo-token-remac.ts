import type { TokenPurpose } from '../../platform/capability-token.ts';
import { all } from '../../platform/db.ts';
import { SEALS, type SealRaw } from '../../platform/repo-capability-token.ts';

/** A row whose token column holds a MAC, with its sealed copy (null when it has none). */
export interface MacRow {
  id: string;
  orgId: string;
  /** The MAC stored now. */
  mac: string;
  seal: SealRaw | null;
}

interface Raw extends Partial<SealRaw> {
  id: string;
  org_id: string;
  mac: string;
}

const COLUMN = { pass: 'download_token', 'apple-auth': 'auth_token', bundle: 'token' } as const;
/** The same text as the partial indexes of 0059 and 0065, without the NOT. */
const MAC_GLOB = "GLOB 'h1:*'";

/** Up to `limit` rows after `after` in id order whose column holds a MAC; the sweep of cron tokens.remac. */
export async function macRows(
  db: D1Database,
  purpose: TokenPurpose,
  after: string | null,
  limit: number,
): Promise<MacRow[]> {
  const { table, column, owner } = SEALS[purpose];
  const rows = await all<Raw>(
    db,
    `SELECT t.id, t.org_id, t.${COLUMN[purpose]} AS mac, s.kek_version, s.iv, s.wrapped_dek, s.ciphertext
     FROM ${owner} t LEFT JOIN ${table} s ON s.${column} = t.id AND s.org_id = t.org_id
     WHERE t.${COLUMN[purpose]} ${MAC_GLOB} AND (? IS NULL OR t.id > ?)
     ORDER BY t.id LIMIT ?`,
    [after, after, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    mac: r.mac,
    seal:
      r.kek_version === null || r.kek_version === undefined
        ? null
        : {
            kek_version: r.kek_version,
            iv: r.iv ?? [],
            wrapped_dek: r.wrapped_dek ?? [],
            ciphertext: r.ciphertext ?? [],
          },
  }));
}
