import type { PassJson } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { jobGrant } from '../../platform/authority.ts';
import { rawCheck } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { CREATE_CODES, createRefusal } from './create-grant.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { credentialReferences } from './credential-references.ts';
import { barcodeHashOf, lookupHashOf, lookupValueOf, primaryBarcodeMessage } from './scan-code.ts';

interface BackfillRow {
  id: string;
  org_id: string;
  mode: Mode;
  identity_id: string;
  template_id: string;
  template_version: string;
  row_version: number;
  version: number;
  credential_generation: number;
  lifecycle_generation: number;
  scan_code: string | null;
  barcode_hash: string | null;
  lookup_hash: string | null;
  removed_at: number | null;
  personalization: string;
  lookup_input: string | null;
  pass_json: string | null;
}

/**
 * Fills `scan_code`, `barcode_hash` and `lookup_hash` on passes that predate them. A key is only
 * a candidate when it can be computed (the barcode exists, the lookup input has a value), so
 * a finished backlog selects nothing. Removed passes keep a NULL `barcode_hash`.
 */
export async function backfillScanKeys(
  ctx: ServiceContext,
  limit: number,
  mintScanCode: () => string,
): Promise<number> {
  const db = ctx.env.DB;
  const credentialEnv = { ...ctx.env };
  await ensureCredentialRefKeyset(db, credentialEnv);
  const rows = await all<BackfillRow>(
    db,
    `SELECT p.id, p.org_id, p.mode, p.identity_id, p.template_id, p.template_version, p.row_version, p.version,
       p.credential_generation, p.lifecycle_generation, p.scan_code, p.barcode_hash, p.lookup_hash, p.removed_at, p.personalization,
       json_extract(tv.manifest, '$.scan.lookup.input') AS lookup_input, pv.pass_json
     FROM passes p
     LEFT JOIN template_versions tv ON tv.template_id = p.template_id AND tv.version = p.template_version
     LEFT JOIN pass_versions pv ON pv.pass_id = p.id AND pv.version = p.version
     WHERE p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
       AND (
       p.scan_code IS NULL
       OR (p.barcode_hash IS NULL AND p.removed_at IS NULL AND (
            json_extract(pv.pass_json, '$.barcodes[0].message') IS NOT NULL
            OR json_extract(pv.pass_json, '$.barcode.message') IS NOT NULL))
       OR (p.lookup_hash IS NULL AND json_extract(tv.manifest, '$.scan.lookup.input') IS NOT NULL
           AND json_extract(p.personalization, '$."' || json_extract(tv.manifest, '$.scan.lookup.input') || '"') IS NOT NULL
           AND json_extract(p.personalization, '$."' || json_extract(tv.manifest, '$.scan.lookup.input') || '"') <> '')
     )
     LIMIT ?`,
    [limit],
  );
  let written = 0;
  for (const row of rows) {
    const passJson = row.pass_json ? (JSON.parse(row.pass_json) as PassJson) : null;
    const scanCode = row.scan_code === null ? mintScanCode() : null;
    const barcodeHash =
      row.barcode_hash === null && row.removed_at === null && passJson
        ? await barcodeHashOf(passJson)
        : null;
    const value =
      row.lookup_hash === null && row.lookup_input
        ? lookupValueOf(JSON.parse(row.personalization), row.lookup_input)
        : null;
    const lookupHash = value === null ? null : await lookupHashOf(value);
    const refs = await credentialReferences(credentialEnv, row.org_id, row.mode, {
      scanCode,
      barcodeHash,
      barcodeMessage: barcodeHash && passJson ? primaryBarcodeMessage(passJson) : null,
      lookupHash,
      lookupValue: value,
    });
    const credentialRefs = [...new Set(refs.map((ref) => ref.ref))];
    const g = jobGrant(ctx, {
      purpose: 'org_mode.job.pass.backfill_scan_keys',
      job: 'pass-scan-keys',
      orgId: row.org_id,
      mode: row.mode,
      target: row.id,
      tables: ['passes'],
      codes: CREATE_CODES,
      checks: [
        rawCheck(
          'stale',
          `(SELECT json_extract(tv.manifest, '$.scan.lookup.input') FROM template_versions tv
            WHERE tv.template_id = ? AND tv.version = ?) IS ?
           AND (SELECT pv.pass_json FROM pass_versions pv WHERE pv.pass_id = ? AND pv.version = ?) IS ?`,
          [
            row.template_id,
            row.template_version,
            row.lookup_input,
            row.id,
            row.version,
            row.pass_json,
          ],
        ),
        rawCheck(
          'lineage',
          "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
          [row.id],
        ),
        tenantCheck(
          'lineage',
          `NOT EXISTS (SELECT 1 FROM pass_credential_tombstones dead WHERE dead.org_id = {org}
            AND dead.mode = {mode} AND dead.credential_hash IN (SELECT value FROM json_each(?)))`,
          [JSON.stringify(credentialRefs)],
        ),
      ],
    });
    g.update('passes', {
      set: {
        scan_code: row.scan_code ?? scanCode,
        barcode_hash: row.barcode_hash ?? barcodeHash,
        lookup_hash: row.lookup_hash ?? lookupHash,
      },
      where: {
        id: row.id,
        row_version: row.row_version,
        credential_generation: row.credential_generation,
        lifecycle_generation: row.lifecycle_generation,
        removed_at: row.removed_at,
        scan_code: row.scan_code,
        barcode_hash: row.barcode_hash,
        lookup_hash: row.lookup_hash,
        deleted_at: null,
      },
      returning: ['id'],
    });
    try {
      const [result] = await g.commit();
      written += result?.results.length ?? 0;
    } catch (error) {
      // A row that moved since the read, or an org that closed, is skipped; the next run retries it.
      if (createRefusal(error) === null) throw error;
    }
  }
  return written;
}
