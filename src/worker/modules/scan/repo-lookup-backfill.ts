import { type Grant, grantedBatch, jobGrant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { coalesceTo } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

type Db = D1Database;

/** Original pass and source data read together before deriving any backfill keys. */
export interface BackfillRow {
  id: string;
  orgId: string;
  mode: 'live' | 'test';
  serial: string;
  rowVersion: number;
  credentialGeneration: number;
  lifecycleGeneration: number;
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
  org_id: string;
  mode: 'live' | 'test';
  serial: string;
  row_version: number;
  credential_generation: number;
  lifecycle_generation: number;
  scan_code: string | null;
  barcode_hash: string | null;
  lookup_hash: string | null;
  removed_at: number | null;
  personalization: string;
  pass_json: string | null;
  lookup_input: string | null;
}

const SOURCE = `FROM (SELECT p.*, (SELECT pass_json FROM pass_versions v
    WHERE v.pass_id=p.id AND v.version<=p.version AND v.pass_json IS NOT NULL
    ORDER BY v.version DESC LIMIT 1) AS pass_json
  FROM passes p WHERE p.deleted_at IS NULL AND p.test_data_quarantined=0) q
  LEFT JOIN template_versions tv ON tv.template_id=q.template_id AND tv.version=q.template_version`;

// Malformed JSON must not raise inside SQL: every path is behind json_valid and json_type, so a
// poison row selects as "nothing to derive" instead of failing the whole page.
const LOOKUP_INPUT = `CASE WHEN json_valid(tv.manifest)
  AND json_type(tv.manifest, '$.scan.lookup.input')='text'
  THEN json_extract(tv.manifest, '$.scan.lookup.input') END`;
// Same precedence as primaryBarcodeMessage: barcodes[0].message unless it is absent or null.
const BARCODE_MESSAGE = `CASE WHEN json_valid(q.pass_json) THEN
  CASE WHEN COALESCE(json_type(q.pass_json, '$.barcodes[0].message'), 'null')!='null'
    THEN CASE WHEN json_type(q.pass_json, '$.barcodes[0].message')='text'
      THEN json_extract(q.pass_json, '$.barcodes[0].message') END
    ELSE CASE WHEN json_type(q.pass_json, '$.barcode.message')='text'
      THEN json_extract(q.pass_json, '$.barcode.message') END
  END END`;
const TYPED_VALUE = `EXISTS (SELECT 1 FROM json_each(
    CASE WHEN json_valid(q.personalization) THEN q.personalization ELSE '{}' END) typed
  WHERE typed.key=(${LOOKUP_INPUT}) AND typed.type IN ('text', 'integer', 'real'))`;
const NEEDS_KEYS = `(q.scan_code IS NULL
  OR (q.barcode_hash IS NULL AND q.removed_at IS NULL AND COALESCE(${BARCODE_MESSAGE}, '')!='')
  OR (q.lookup_hash IS NULL AND (${LOOKUP_INPUT}) IS NOT NULL AND ${TYPED_VALUE}))`;
const PENDING = `EXISTS (SELECT 1 FROM pass_credential_transfers transfer
  WHERE transfer.pass_id=q.id AND transfer.state='pending')`;

/**
 * One page of passes missing keys, after `after` in id order. A pending transfer is excluded here
 * and checked again at the write. The cursor means a row that cannot be written never starves
 * the rows behind it.
 */
export async function backfillCandidates(
  db: Db,
  after: string | null,
  limit: number,
): Promise<BackfillRow[]> {
  const rows = await all<BackfillRaw>(
    db,
    `SELECT q.id, q.org_id, q.mode, q.serial, q.row_version, q.credential_generation,
    q.lifecycle_generation, q.scan_code, q.barcode_hash, q.lookup_hash,
    q.removed_at, q.personalization, q.pass_json, (${LOOKUP_INPUT}) AS lookup_input
    ${SOURCE} WHERE (? IS NULL OR q.id>?) AND ${NEEDS_KEYS} AND NOT ${PENDING}
    ORDER BY q.id LIMIT ?`,
    [after, after, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    serial: r.serial,
    rowVersion: r.row_version,
    credentialGeneration: r.credential_generation,
    lifecycleGeneration: r.lifecycle_generation,
    scanCode: r.scan_code,
    barcodeHash: r.barcode_hash,
    lookupHash: r.lookup_hash,
    removedAt: r.removed_at,
    personalization: r.personalization,
    passJson: r.pass_json,
    lookupInput: r.lookup_input,
  }));
}

/** A pass still waiting on a credential transfer keeps the backfill open: it is retried, not skipped. */
export async function backfillBlockedByTransfer(db: Db): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 AS blocked ${SOURCE} WHERE ${NEEDS_KEYS} AND ${PENDING} LIMIT 1`,
    )) !== null
  );
}

/** Where the sweep stands. `sweeps` bounds the restarts; `failed` and `wrote` decide whether to restart. */
export interface BackfillState {
  after: string | null;
  wrote: number;
  failed: number;
  sweeps: number;
}

export const FRESH_STATE: BackfillState = { after: null, wrote: 0, failed: 0, sweeps: 0 };

export function parseBackfillState(value: unknown): BackfillState {
  if (!value || typeof value !== 'object') return { ...FRESH_STATE };
  const v = value as Partial<BackfillState>;
  const count = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  return {
    after: typeof v.after === 'string' ? v.after : null,
    wrote: count(v.wrote),
    failed: count(v.failed),
    sweeps: count(v.sweeps),
  };
}

/** The system-scope settings rows are written by the job itself, under a platform job grant. */
function settingsGrant(ctx: ServiceContext, target: string): Grant {
  return jobGrant(ctx, { purpose: 'platform.job.scan.backfill', job: 'scan.backfill', target });
}

function upsertSetting(g: Grant, key: string, value: unknown, now: number): void {
  g.upsert(
    'settings',
    ['scope', 'key', 'value', 'updated_at'],
    ['system', key, JSON.stringify(value), now],
    {
      update: ['value', 'updated_at'],
    },
  );
}

export async function saveBackfillState(
  ctx: ServiceContext,
  key: string,
  state: BackfillState,
): Promise<void> {
  const g = settingsGrant(ctx, key);
  upsertSetting(g, key, state, ctx.clock.now());
  await g.commit();
}

/**
 * No pass of an active org may be left without its scan code, whatever the sweep saw: a pass that
 * arrived after the last empty read keeps the backfill open. (Barcode and lookup hashes can be
 * underivable from poison data; the scan code never is.)
 */
const noUnkeyedPass: Check = {
  reason: 'lineage',
  ok: () => `NOT EXISTS (SELECT 1 FROM passes q
    JOIN orgs qo ON qo.id = q.org_id AND qo.status = 'active'
    WHERE q.scan_code IS NULL AND q.deleted_at IS NULL AND q.test_data_quarantined = 0)`,
};

/** Mark the backfill finished and reset the sweep in one batch. False when a pass still needs a code. */
export async function completeBackfill(
  ctx: ServiceContext,
  doneKey: string,
  stateKey: string,
): Promise<boolean> {
  const g = jobGrant(ctx, {
    purpose: 'platform.job.scan.backfill',
    job: 'scan.backfill',
    target: doneKey,
    checks: [noUnkeyedPass],
  });
  const now = ctx.clock.now();
  upsertSetting(g, doneKey, true, now);
  upsertSetting(g, stateKey, FRESH_STATE, now);
  try {
    await g.commit();
    return true;
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return false;
    throw error;
  }
}

/** The derived values the job computed for one row. */
export interface BackfillKeys {
  scanCode: string | null;
  barcodeHash: string | null;
  lookupHash: string | null;
}

// Both derive from the row the job read, so a changed row (`row_version`) or a moved credential
// (generations) refuses the write. A pending transfer and a retired credential still refuse it.
const noPendingTransfer = (passId: string): Check => ({
  reason: 'lineage',
  ok: (b) =>
    `NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
      WHERE transfer.pass_id = ${b.bind(passId)} AND transfer.state = 'pending')`,
});

const noTombstones = (refs: readonly string[]): Check => ({
  reason: 'lineage',
  ok: (b) =>
    `NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tombstone
      WHERE tombstone.org_id = a.org_id AND tombstone.mode = a.mode
        AND tombstone.credential_hash IN (SELECT value FROM json_each(${b.bind(JSON.stringify(refs))})))`,
});

/** A grant that fills the missing keys of one pass; `null` when the inputs are not sound. */
export function backfillGrant(
  ctx: ServiceContext,
  row: BackfillRow,
  keys: BackfillKeys,
  refs: readonly string[],
): Grant | null {
  if (
    !Number.isSafeInteger(row.credentialGeneration) ||
    row.credentialGeneration < 1 ||
    !Number.isSafeInteger(row.lifecycleGeneration) ||
    row.lifecycleGeneration < 0 ||
    refs.length === 0 ||
    refs.some((ref) => !/^[0-9a-f]{64}$/.test(ref))
  )
    return null;
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.scan.backfill',
    job: 'scan.backfill',
    orgId: row.orgId,
    mode: row.mode,
    target: row.id,
    checks: [
      rowIs('passes', row.id, { row_version: row.rowVersion }, 'stale'),
      rowIs(
        'passes',
        row.id,
        {
          credential_generation: row.credentialGeneration,
          lifecycle_generation: row.lifecycleGeneration,
          test_data_quarantined: 0,
          deleted_at: null,
        },
        'lineage',
      ),
      noPendingTransfer(row.id),
      noTombstones(refs),
    ],
  });
  // scan_code, barcode_hash and lookup_hash move row_version only when they were already set, so
  // filling an empty one does not bump every pass the backfill touches.
  g.update('passes', {
    set: {
      scan_code: coalesceTo(keys.scanCode),
      barcode_hash: coalesceTo(keys.barcodeHash),
      lookup_hash: coalesceTo(keys.lookupHash),
    },
    where: { id: row.id },
    require: 'one',
  });
  return g;
}

/** Commit grants in one batch; the caller falls back to one grant each when the batch is refused. */
export async function commitBackfill(db: Db, grants: Grant[]): Promise<void> {
  if (grants.length) await grantedBatch(db, grants);
}
