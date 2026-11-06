import { all, stmt } from '../../platform/db.ts';
import { mapPass, type Pass, type PassDbRow } from '../passes/repo-map.ts';

type Db = D1Database;

/** A pass with the latest recorded pass.json, read in the same statement. */
export interface Candidate {
  pass: Pass;
  passJson: string | null;
}

type Raw = PassDbRow & { pass_json: string | null };

const SELECT = `SELECT p.*, (SELECT pass_json FROM pass_versions v
    WHERE v.pass_id = p.id AND v.pass_json IS NOT NULL ORDER BY v.version DESC LIMIT 1) AS pass_json
  FROM passes p WHERE p.org_id = ? AND p.deleted_at IS NULL`;

const toCandidate = (r: Raw): Candidate => ({ pass: mapPass(r), passJson: r.pass_json });

/** Every lookup is `org_id = ?` first: another tenant's code is the same as no code. */
const lookup = (db: Db, orgId: string, column: string, value: string, limit: number) =>
  stmt(db, `${SELECT} AND p.${column} = ? LIMIT ${limit}`, [orgId, value]);

export const byScanCodeStmt = (db: Db, orgId: string, code: string) =>
  lookup(db, orgId, 'scan_code', code, 2);
export const byBarcodeHashStmt = (db: Db, orgId: string, hash: string) =>
  lookup(db, orgId, 'barcode_hash', hash, 5);
export const byLookupHashStmt = (db: Db, orgId: string, hash: string) =>
  lookup(db, orgId, 'lookup_hash', hash, 5);
export const byExternalIdStmt = (db: Db, orgId: string, value: string) =>
  lookup(db, orgId, 'external_id', value, 5);
export const bySerialStmt = (db: Db, orgId: string, value: string) =>
  lookup(db, orgId, 'serial', value, 5);
export const byIdStmt = (db: Db, orgId: string, id: string) => lookup(db, orgId, 'id', id, 1);

export const candidatesOf = (result: D1Result | undefined): Candidate[] =>
  ((result?.results ?? []) as Raw[]).map(toCandidate);

export async function candidateById(db: Db, orgId: string, id: string): Promise<Candidate | null> {
  const row = await byIdStmt(db, orgId, id).first<Raw>();
  return row ? toCandidate(row) : null;
}

export interface BackfillRow {
  id: string;
  scanCode: string | null;
  barcodeHash: string | null;
  lookupHash: string | null;
  removedAt: number | null;
  personalization: string;
  passJson: string | null;
  lookupInput: string | null;
}

interface BackfillRaw {
  id: string;
  scan_code: string | null;
  barcode_hash: string | null;
  lookup_hash: string | null;
  removed_at: number | null;
  personalization: string;
  pass_json: string | null;
  lookup_input: string | null;
}

/**
 * Passes missing a key they could have: `scan_code`, `barcode_hash` (not removed, has a barcode) or
 * `lookup_hash` (the template names a lookup input the pass has a value for). A row leaves the set
 * once written, so the set drains and the job can stop.
 */
export async function backfillCandidates(db: Db, limit: number): Promise<BackfillRow[]> {
  const rows = await all<BackfillRaw>(
    db,
    `SELECT q.id, q.scan_code, q.barcode_hash, q.lookup_hash, q.removed_at, q.personalization, q.pass_json,
       json_extract(tv.manifest, '$.scan.lookup.input') AS lookup_input
     FROM (SELECT p.*, (SELECT pass_json FROM pass_versions v
             WHERE v.pass_id = p.id AND v.pass_json IS NOT NULL ORDER BY v.version DESC LIMIT 1) AS pass_json
           FROM passes p WHERE p.deleted_at IS NULL) q
     LEFT JOIN template_versions tv ON tv.template_id = q.template_id AND tv.version = q.template_version
     WHERE q.scan_code IS NULL
       OR (q.barcode_hash IS NULL AND q.removed_at IS NULL
           AND COALESCE(json_extract(q.pass_json, '$.barcodes[0].message'), json_extract(q.pass_json, '$.barcode.message'), '') != '')
       OR (q.lookup_hash IS NULL AND json_extract(tv.manifest, '$.scan.lookup.input') IS NOT NULL
           AND json_extract(q.personalization, '$.' || json_extract(tv.manifest, '$.scan.lookup.input')) IS NOT NULL)
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    scanCode: r.scan_code,
    barcodeHash: r.barcode_hash,
    lookupHash: r.lookup_hash,
    removedAt: r.removed_at,
    personalization: r.personalization,
    passJson: r.pass_json,
    lookupInput: r.lookup_input,
  }));
}

export const writeKeysStmt = (
  db: Db,
  id: string,
  keys: { scanCode: string | null; barcodeHash: string | null; lookupHash: string | null },
) =>
  stmt(
    db,
    `UPDATE passes SET scan_code = COALESCE(scan_code, ?), barcode_hash = COALESCE(barcode_hash, ?),
       lookup_hash = COALESCE(lookup_hash, ?) WHERE id = ?`,
    [keys.scanCode, keys.barcodeHash, keys.lookupHash, id],
  );
