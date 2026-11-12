import { expect } from 'vitest';
import { first, run, type SqlValue } from '../../platform/db.ts';
import type { PreparedAssetGrant } from './asset-types.ts';
import type { Candidate } from './repo-lookup.ts';
import { boundOutputPredicate, type OutputPredicate } from './repo-output-predicates.ts';
import type { ScanKit } from './test-kit.ts';

export async function seedScannerSetup(
  db: D1Database,
  scannerId: string,
  orgId: string,
  userId: string,
) {
  await run(
    db,
    `INSERT INTO scanner_setups
    (scanner_id, org_id, mode, admin_session, admin_user_id) VALUES (?, ?, 'live', 1, ?)`,
    [scannerId, orgId, userId],
  );
}

export async function seedAssetScanningWorkspace(
  db: D1Database,
  workspaceId: string,
  eventId: string,
  now: number,
  deviceId: string,
  sourceDeviceId: string,
  orgId: string,
) {
  await run(
    db,
    `INSERT INTO scanning_sessions
    (id, org_id, mode, name, accepts, settings, time_zone, created_at, updated_at)
    SELECT ?, org_id, mode, 'Asset budget', ?, settings, time_zone, ?, ? FROM scanners WHERE id = ?`,
    [workspaceId, JSON.stringify({ eventId }), now, now, deviceId],
  );
  for (const scannerId of [deviceId, sourceDeviceId]) {
    await run(
      db,
      `INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode)
      VALUES (?, ?, ?, 'live')`,
      [scannerId, workspaceId, orgId],
    );
  }
}

/** Mimic nested action fences at their scalar limit and force multiple nonsecret JSON segments. */
export function actionExtra(candidate: Candidate): OutputPredicate {
  const secretConditions: string[] = [];
  const secretParams: SqlValue[] = [candidate.pass.id];
  for (let i = 0; i < 27; i++) {
    secretConditions.push(`p.auth_token IS ?/* scan-ephemeral-auth-token */
      AND p.download_token IS ?/* scan-ephemeral-download-token */
      AND p.scan_code IS ?/* scan-ephemeral-scan-code */`);
    secretParams.push(
      candidate.pass.authToken,
      candidate.pass.downloadToken,
      candidate.pass.scanCode,
    );
  }
  const inner = boundOutputPredicate({
    sql: `p.id=?/* scan-ephemeral-pass-id */ AND ${secretConditions.join(' AND ')}`,
    params: secretParams,
  });
  expect(inner.sql).not.toBe('0');
  const metadata = Array.from(
    { length: 66 },
    (_, index) => `BUDGET_META_${index}_${'x'.repeat(16_384)}`,
  );
  const outer = boundOutputPredicate({
    sql: `(${inner.sql}) AND ${metadata.map(() => 'length(?) > 0').join(' AND ')}`,
    params: [...inner.params, ...metadata],
  });
  expect(outer.sql).not.toBe('0');
  return outer;
}

export async function stored(kit: ScanKit, plan: PreparedAssetGrant) {
  return first<{ token_hash: string; credential_refs: string }>(
    kit.env.DB,
    'SELECT token_hash, credential_refs FROM scan_asset_grant_provenance WHERE token_hash = ?',
    [plan.tokenHash],
  );
}
