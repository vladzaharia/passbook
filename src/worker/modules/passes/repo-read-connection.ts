import type { Mode } from '../../../shared/contracts/common.ts';
import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import { first } from '../../platform/db.ts';
import {
  type ConnectionPassContext,
  connectionPassParams,
  connectionPassPredicate,
  validConnectionPassContext,
} from './repo-connection-context.ts';
import type { Pass } from './repo-map.ts';

export async function connectionInOrg(
  db: D1Database,
  connectionId: string,
  orgId: string,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    'SELECT id FROM connections WHERE id = ? AND org_id = ?',
    [connectionId, orgId],
  );
  return row !== null;
}

/** Capture pending state only if the previously authorized pass snapshot still matches. */
export async function captureConnectionTransferPending(
  db: D1Database,
  pass: Pass,
): Promise<boolean | null> {
  const row = await first<{ pending: number }>(
    db,
    `SELECT EXISTS (
      SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending'
    ) AS pending FROM passes p
    WHERE p.id = ? AND p.org_id = ? AND p.mode = ? AND p.identity_id = ?
      AND p.version = ? AND p.revision = ? AND p.link_generation = ?
      AND p.credential_generation = ? AND p.lifecycle_generation = ?
      AND p.owner_user_id IS ? AND p.holder_email IS ? AND p.status = ?
      AND p.connection_id IS ? AND p.external_ref IS ?
      AND p.template_id = ? AND p.template_version = ? AND p.release_id IS ?
      AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.test_data_quarantined = 0`,
    [
      pass.id,
      pass.orgId,
      pass.mode,
      pass.identityId,
      pass.version,
      pass.revision,
      pass.linkGeneration,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      pass.ownerUserId,
      pass.holderEmail,
      pass.status,
      pass.connectionId,
      pass.externalRef,
      pass.templateId,
      pass.templateVersion,
      pass.releaseId,
    ],
  );
  return row ? row.pending === 1 : null;
}

export async function matchesConnectionPass(
  db: D1Database,
  context: ConnectionPassContext,
): Promise<boolean> {
  if (!validConnectionPassContext(context)) return false;
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE id = ? AND ${connectionPassPredicate}`,
    [context.passId, ...connectionPassParams(context)],
  );
  return row !== null;
}

/** Connections have no Test environment; their `mode` is only the scheduling strategy. */
export async function connectionForPass(
  db: D1Database,
  connectionId: string,
  orgId: string,
  mode: Mode,
  expectedConnectionMode?: ConnectionMode,
): Promise<{ generation: number; mode: ConnectionMode } | null> {
  if (mode !== 'live') return null;
  return first<{ generation: number; mode: ConnectionMode }>(
    db,
    `SELECT generation, mode FROM connections WHERE id = ? AND org_id = ? AND enabled = 1
      AND (? IS NULL OR mode = ?)`,
    [connectionId, orgId, expectedConnectionMode ?? null, expectedConnectionMode ?? null],
  );
}

export async function findByConnectionRef(
  db: D1Database,
  orgId: string,
  connectionId: string,
  externalRef: string,
): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    'SELECT id FROM passes WHERE connection_id = ? AND external_ref = ? AND org_id = ?',
    [connectionId, externalRef, orgId],
  );
  return row?.id ?? null;
}
