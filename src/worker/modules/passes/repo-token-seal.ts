import { type Grant, jobGrant } from '../../platform/authority.ts';
import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { type SealRow, sealPart, type TokenPurpose } from '../../platform/capability-token.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** A row whose token column still holds the plain token (written before the tokens were sealed). */
export interface PlainTokenRow {
  id: string;
  orgId: string;
  mode: 'live' | 'test';
  rowVersion: number | null;
  /** The plain token. */
  token: string;
}

interface Raw {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  row_version: number | null;
  token: string;
}

const map = (r: Raw): PlainTokenRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  rowVersion: r.row_version,
  token: r.token,
});

/**
 * Passes still holding a plain token, after `after` in id order. A pending credential transfer waits, and
 * so does a pass of a deleted or inactive org (no job grant can write it): sealed once the org is active.
 */
export async function plainPasses(
  db: D1Database,
  after: string | null,
  limit: number,
): Promise<PlainTokenRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT id, org_id, mode, row_version, download_token AS token FROM passes
     WHERE download_token NOT LIKE 'h1:%' AND (? IS NULL OR id > ?)
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = passes.org_id AND o.status = 'active')
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')
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
    `SELECT id, org_id, mode, NULL AS row_version, token FROM bundles
     WHERE token NOT LIKE 'h1:%' AND (? IS NULL OR id > ?)
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = bundles.org_id AND o.status = 'active')
       AND NOT EXISTS (SELECT 1 FROM sandbox_forwards f
         WHERE f.bundle_id = bundles.id AND f.state IN ('sending', 'unknown'))
     ORDER BY id LIMIT ?`,
    [after, after, limit],
  );
  return rows.map(map);
}

const noPendingTransfer = (passId: string): Check =>
  rawCheck(
    'lineage',
    "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
    [passId],
  );

/**
 * Replaces the plain token with its MAC and keeps the sealed copy, in one grant. The write holds only
 * for the row as read (token and, for a pass, `row_version`); the 0059 triggers keep it from counting
 * as a pass change. An existing sealed copy is kept.
 */
export function sealGrant(
  ctx: ServiceContext,
  purpose: TokenPurpose,
  row: PlainTokenRow,
  mac: string,
  seal: SealRow,
): Grant {
  const pass = purpose === 'pass';
  const g = jobGrant(ctx, {
    purpose: `org_mode.job.${purpose}.token_seal`,
    job: 'token.seal',
    orgId: row.orgId,
    mode: row.mode,
    target: row.id,
    tables: pass ? ['passes', 'pass_token_seals'] : ['bundles', 'bundle_token_seals'],
    checks: [
      rowIs(
        pass ? 'passes' : 'bundles',
        row.id,
        {
          ...(pass ? { row_version: row.rowVersion } : {}),
          [pass ? 'download_token' : 'token']: row.token,
        },
        'stale',
      ),
      ...(pass ? [noPendingTransfer(row.id)] : []),
    ],
  });
  g.update(pass ? 'passes' : 'bundles', {
    set: { [pass ? 'download_token' : 'token']: mac },
    where: { id: row.id },
    require: 'one',
  });
  g.include(sealPart(purpose, row.id, mac, seal, { replace: false }));
  return g;
}
