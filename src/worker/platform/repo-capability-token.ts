import { type GrantPart, writePart } from './authority-include.ts';
import { exactStmt, first } from './db.ts';

export type TokenPurpose = 'pass' | 'bundle';

export interface SealRow {
  kekVersion: number;
  iv: Uint8Array;
  wrappedDek: Uint8Array;
  ciphertext: Uint8Array;
}

/** Where each purpose keeps its token and its sealed copy; `kind` is the AAD purpose. */
export const SEALS = {
  pass: {
    table: 'pass_token_seals',
    column: 'pass_id',
    owner: 'passes',
    tokenColumn: 'download_token',
    kind: 'pass-link',
  },
  bundle: {
    table: 'bundle_token_seals',
    column: 'bundle_id',
    owner: 'bundles',
    tokenColumn: 'token',
    kind: 'bundle-link',
  },
} as const;

const upsertSql = (purpose: TokenPurpose, replace: boolean, org: string, tail: string) => {
  const s = SEALS[purpose];
  return `INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO ${s.table}
       (${s.column}, org_id, kek_version, iv, wrapped_dek, ciphertext)
     SELECT t.id, ${org}, ?, ?, ?, ? FROM ${s.owner} t
     WHERE t.id = ? AND t.${s.tokenColumn} = ? ${tail}`;
};
const sealParams = (id: string, mac: string, s: SealRow) => [
  s.kekVersion,
  s.iv,
  s.wrappedDek,
  s.ciphertext,
  id,
  mac,
];

/**
 * The sealed copy, written inside the grant's batch after the row carries `mac`: it lands only for that
 * row state, so a refused or lost token write never leaves a copy of a token the row does not hold.
 * `replace: false` keeps a copy already there (the backfill never overwrites a rotation's).
 */
export function sealPart(
  purpose: TokenPurpose,
  id: string,
  mac: string,
  seal: SealRow,
  options: { replace?: boolean; holder?: boolean } = {},
): GrantPart {
  const replace = options.replace ?? true;
  // A holder grant is pinned to its pass: the row is named by {pass}, never by a value of the caller.
  if (options.holder) {
    const s = SEALS[purpose];
    return writePart(
      `INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO ${s.table}
         (${s.column}, org_id, kek_version, iv, wrapped_dek, ciphertext)
       SELECT {pass}, {org}, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM ${s.owner} t WHERE t.id = {pass} AND t.${s.tokenColumn} = ?) AND {grant}`,
      [seal.kekVersion, seal.iv, seal.wrappedDek, seal.ciphertext, mac],
    );
  }
  return writePart(
    upsertSql(purpose, replace, '{org}', 'AND t.org_id = {org} AND t.mode = {mode} AND {grant}'),
    sealParams(id, mac, seal),
  );
}

/** The same write for a caller without a grant; batch it right after the token write. */
export function sealStatement(
  db: D1Database,
  purpose: TokenPurpose,
  id: string,
  mac: string,
  seal: SealRow,
): D1PreparedStatement {
  return exactStmt(db, upsertSql(purpose, true, 't.org_id', ''), sealParams(id, mac, seal));
}

export interface SealRaw {
  kek_version: number;
  iv: number[] | ArrayBuffer;
  wrapped_dek: number[] | ArrayBuffer;
  ciphertext: number[] | ArrayBuffer;
}

export function readSeal(
  db: D1Database,
  purpose: TokenPurpose,
  id: string,
  orgId: string,
): Promise<SealRaw | null> {
  const s = SEALS[purpose];
  return first<SealRaw>(
    db,
    `SELECT kek_version, iv, wrapped_dek, ciphertext FROM ${s.table} WHERE ${s.column} = ? AND org_id = ?`,
    [id, orgId],
  );
}
