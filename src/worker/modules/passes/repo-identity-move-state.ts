import { all, first, run } from '../../platform/db.ts';

export interface AssetRow {
  name: string;
  r2_key: string;
  sha1: string;
  size: number;
  width: number | null;
  height: number | null;
  crc32: number | null;
  created_at: number;
}
export interface PhotoRow {
  r2_key: string;
  sha1: string;
  size: number;
  crc32: number;
  include_in_pass: number;
  version: string;
  updated_at: number;
}
export interface NoteRow {
  body: string;
  author_name: string;
  author_staff_id: string | null;
  scanner_id: string | null;
  idempotency_key: string;
  created_at: number;
  edited_at: number | null;
}
export interface SealedRow {
  token_sha256: string;
  kek_version: number;
  iv: ArrayBuffer;
  wrapped_dek: ArrayBuffer;
  ciphertext: ArrayBuffer;
  created_at: number;
  published_at: number | null;
}

/** What the old pass holds that the replacement gets a copy of, read once. */
export interface PassState {
  assets: AssetRow[];
  photo: PhotoRow | null;
  notes: NoteRow[];
}

export async function readState(db: D1Database, passId: string): Promise<PassState> {
  const [assets, photo, notes] = await Promise.all([
    all<AssetRow>(
      db,
      `SELECT name, r2_key, sha1, size, width, height, crc32, created_at FROM pass_assets
       WHERE pass_id = ? ORDER BY name`,
      [passId],
    ),
    first<PhotoRow>(
      db,
      `SELECT r2_key, sha1, size, crc32, include_in_pass, version, updated_at FROM member_photos
       WHERE pass_id = ?`,
      [passId],
    ),
    all<NoteRow>(
      db,
      `SELECT body, author_name, author_staff_id, scanner_id, idempotency_key, created_at, edited_at
       FROM pass_notes WHERE pass_id = ? ORDER BY created_at, id`,
      [passId],
    ),
  ]);
  return { assets, photo, notes };
}

/** Check-in rules go to the replacement unchanged; the first copy wins. */
export async function copyCheckIn(
  db: D1Database,
  from: { id: string; orgId: string },
  toId: string,
  now: number,
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO pass_check_in (pass_id, org_id, rules, updated_at)
     SELECT ?, org_id, rules, ? FROM pass_check_in WHERE pass_id = ? AND org_id = ?`,
    [toId, now, from.id, from.orgId],
  );
}

export function sealedOf(db: D1Database, passId: string): Promise<SealedRow | null> {
  return first<SealedRow>(
    db,
    `SELECT token_sha256, kek_version, iv, wrapped_dek, ciphertext, created_at, published_at
     FROM pass_personalizations WHERE pass_id = ?`,
    [passId],
  );
}

export async function insertSealed(
  db: D1Database,
  passId: string,
  row: SealedRow,
  sealed: { kekVersion: number; iv: Uint8Array; wrappedDek: Uint8Array; ciphertext: Uint8Array },
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO pass_personalizations
       (pass_id, token_sha256, kek_version, iv, wrapped_dek, ciphertext, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      passId,
      row.token_sha256,
      sealed.kekVersion,
      sealed.iv,
      sealed.wrappedDek,
      sealed.ciphertext,
      row.created_at,
      row.published_at,
    ],
  );
}

/** How many carried rows the pass holds: a change between two reads means something was copied. */
export async function carriedCount(db: D1Database, passId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT (SELECT count(*) FROM pass_assets WHERE pass_id = ?1)
       + (SELECT count(*) FROM member_photos WHERE pass_id = ?1) + (SELECT count(*) FROM pass_notes WHERE pass_id = ?1)
       + (SELECT count(*) FROM pass_check_in WHERE pass_id = ?1)
       + (SELECT count(*) FROM pass_personalizations WHERE pass_id = ?1) AS n`,
    [passId],
  );
  return row?.n ?? 0;
}

/** What the void moves onto the replacement: the old pass's bundles, printed card and NFC tags. */
export interface Repoint {
  bundles: { bundle_id: string; position: number }[];
  print: { id: string; code_pass_id: string | null } | null;
  tags: TagRow[];
}

export interface TagRow {
  id: string;
  tag_id: string;
  source: string;
  bound_at: number;
  bound_by_type: string;
  bound_by: string;
  scanner_id: string | null;
  expires_at: number | null;
}

export async function readRepoint(db: D1Database, oldPassId: string): Promise<Repoint> {
  const [bundles, print, tags] = await Promise.all([
    all<Repoint['bundles'][number]>(
      db,
      'SELECT bundle_id, position FROM bundle_passes WHERE pass_id = ? ORDER BY bundle_id',
      [oldPassId],
    ),
    first<NonNullable<Repoint['print']>>(
      db,
      "SELECT id, code_pass_id FROM pass_prints WHERE pass_id = ? AND status = 'active'",
      [oldPassId],
    ),
    all<TagRow>(
      db,
      `SELECT id, tag_id, source, bound_at, bound_by_type, bound_by, scanner_id, expires_at
       FROM tag_bindings WHERE pass_id = ? AND scope = 'pass' AND ended_at IS NULL ORDER BY id`,
      [oldPassId],
    ),
  ]);
  return { bundles, print, tags };
}
