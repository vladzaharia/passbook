import { type Grant, jobGrant } from '../../platform/authority.ts';
import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { type SealRow, sealPart, type TokenPurpose } from '../../platform/capability-token.ts';
import { all, first, run } from '../../platform/db.ts';
import { SEALS } from '../../platform/repo-capability-token.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** A row whose token column still holds the plain token (written before the tokens were sealed). */
export interface PlainTokenRow {
  id: string;
  orgId: string;
  mode: 'live' | 'test';
  rowVersion: number | null;
  /** The plain token. */
  token: string;
  /** A job grant needs an active org; the rows of any other org are sealed by the trusted write. */
  orgActive: boolean;
}

interface Raw {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  row_version: number | null;
  token: string;
  org_active: number;
}

const map = (r: Raw): PlainTokenRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  rowVersion: r.row_version,
  token: r.token,
  orgActive: r.org_active === 1,
});

export const PASS_PENDING = `EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')`;
export const PASS_RESERVED = `EXISTS (SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
  WHERE fp.pass_id = passes.id AND f.state IN ('sending', 'unknown'))`;
export const BUNDLE_RESERVED = `EXISTS (SELECT 1 FROM sandbox_forwards f
  WHERE f.bundle_id = bundles.id AND f.state IN ('sending', 'unknown'))`;
const ORG_ACTIVE = (table: string) =>
  `COALESCE((SELECT o.status = 'active' FROM orgs o WHERE o.id = ${table}.org_id), 0)`;

/**
 * Passes still holding a plain token in `column` (the download link or the Apple web-service token),
 * after `after` in id order. A pending transfer or a reservation waits.
 */
export async function plainPasses(
  db: D1Database,
  column: 'download_token' | 'auth_token',
  after: string | null,
  limit: number,
): Promise<PlainTokenRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT id, org_id, mode, row_version, ${column} AS token, ${ORG_ACTIVE('passes')} AS org_active
     FROM passes WHERE ${column} NOT LIKE 'h1:%' AND (? IS NULL OR id > ?)
       AND NOT ${PASS_PENDING} AND NOT ${PASS_RESERVED}
     ORDER BY id LIMIT ?`,
    [after, after, limit],
  );
  return rows.map(map);
}

/** Bundles still holding a plain token; one in a forwarding reservation is locked and waits. */
export async function plainBundles(
  db: D1Database,
  after: string | null,
  limit: number,
): Promise<PlainTokenRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT id, org_id, mode, NULL AS row_version, token, ${ORG_ACTIVE('bundles')} AS org_active
     FROM bundles WHERE token NOT LIKE 'h1:%' AND (? IS NULL OR id > ?)
       AND NOT ${BUNDLE_RESERVED}
     ORDER BY id LIMIT ?`,
    [after, after, limit],
  );
  return rows.map(map);
}

/** Rows still holding a plain token, waiting rows included. Zero means the plain lookup can go. */
export async function countPlain(db: D1Database): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT (SELECT count(*) FROM passes WHERE download_token NOT LIKE 'h1:%')
          + (SELECT count(*) FROM passes WHERE auth_token NOT LIKE 'h1:%')
          + (SELECT count(*) FROM bundles WHERE token NOT LIKE 'h1:%') AS n`,
  );
  return row?.n ?? 0;
}

/** A stored pass.json that still carries the device token (written before 0065); the partial index of 0065. */
const SCRUB_WORK = `CASE WHEN json_valid(pass_json) THEN json_type(pass_json, '$.authenticationToken') END IS NOT NULL`;

/** Removes the device token from up to `limit` stored pass.json copies; returns how many were rewritten. */
export async function scrubPassJson(db: D1Database, limit: number): Promise<number> {
  const result = await run(
    db,
    `UPDATE pass_versions SET pass_json = json_remove(pass_json, '$.authenticationToken')
     WHERE (pass_id, version) IN (SELECT pass_id, version FROM pass_versions WHERE ${SCRUB_WORK} LIMIT ?)`,
    [limit],
  );
  return result.changes;
}

/** Stored pass.json copies still carrying the device token. */
export async function countUnscrubbed(db: D1Database): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM pass_versions WHERE ${SCRUB_WORK}`,
  );
  return row?.n ?? 0;
}

const noPendingTransfer = (passId: string): Check =>
  rawCheck(
    'lineage',
    "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
    [passId],
  );

const noReservation = (id: string, purpose: TokenPurpose): Check =>
  rawCheck(
    'lineage',
    purpose === 'pass'
      ? `NOT EXISTS (SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
          WHERE fp.pass_id = ? AND f.state IN ('sending', 'unknown'))`
      : `NOT EXISTS (SELECT 1 FROM sandbox_forwards f WHERE f.bundle_id = ? AND f.state IN ('sending', 'unknown'))`,
    [id],
  );

/**
 * Replaces the plain token with its MAC and keeps the sealed copy, in one grant. The write holds only
 * for the row as read (token and, for a pass, `row_version`); the 0059 and 0065 triggers keep it from
 * counting as a pass change. An existing sealed copy is kept.
 */
export function sealGrant(
  ctx: ServiceContext,
  purpose: TokenPurpose,
  row: PlainTokenRow,
  mac: string,
  seal: SealRow,
): Grant {
  const { owner, table, tokenColumn } = SEALS[purpose];
  const pass = owner === 'passes';
  const g = jobGrant(ctx, {
    purpose: `org_mode.job.${purpose === 'apple-auth' ? 'pass.apple_auth' : purpose}.token_seal`,
    job: 'token.seal',
    orgId: row.orgId,
    mode: row.mode,
    target: row.id,
    tables: [owner, table],
    checks: [
      rowIs(
        owner,
        row.id,
        { ...(pass ? { row_version: row.rowVersion } : {}), [tokenColumn]: row.token },
        'stale',
      ),
      ...(pass
        ? [noPendingTransfer(row.id), noReservation(row.id, 'pass')]
        : [noReservation(row.id, 'bundle')]),
    ],
  });
  g.update(owner, { set: { [tokenColumn]: mac }, where: { id: row.id }, require: 'one' });
  g.include(sealPart(purpose, row.id, mac, seal));
  return g;
}
