import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ConnectionPassContext } from './repo-connection-context.ts';
import type { CredentialTransferTarget } from './repo-credential-transfer-read.ts';

/** The target owner is the unique unblocked verified owner of the holder email (or there is none). */
export function eligibleOwner(passId: string, t: CredentialTransferTarget): Check {
  const owner = t.ownerUserId;
  return rawCheck(
    'lineage',
    `(? IS NULL OR (? IS NOT NULL AND EXISTS (
      SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
      WHERE u.id = ? AND u.status = 'active' AND e.email = ?)
    AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = ? AND b.user_id = ?)
    AND NOT EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
      WHERE u.id != ? AND u.status = 'active' AND e.email = ?
        AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = ? AND b.user_id = u.id))))`,
    [owner, owner, owner, t.holderEmail, passId, owner, owner, t.holderEmail, passId],
  );
}

/** No retained webhook claim, unknown mail outcome or pending transfer holds the pass. */
export function noOpenClaims(passId: string): Check[] {
  return [
    rawCheck(
      'lineage',
      "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
      [passId],
    ),
    tenantCheck(
      'lineage',
      `NOT EXISTS (SELECT 1 FROM connection_webhook_items item
        JOIN connection_webhook_retention retained ON retained.id = item.retention_id
        WHERE item.state IN ('started', 'uncertain') AND (item.claim_pass_id = ?
          OR (item.claim_prior_unbound = 1 AND retained.org_id = {org})))`,
      [passId],
    ),
    rawCheck(
      'lineage',
      `NOT EXISTS (SELECT 1 FROM pass_issuance_deliveries issuance
        JOIN outbox ob ON ob.id = issuance.outbox_id
        WHERE issuance.pass_id = ? AND issuance.state = 'queued'
          AND ob.state = 'processing' AND ob.error_code = 'EMAIL_OUTCOME_UNKNOWN')`,
      [passId],
    ),
  ];
}

/** None of the new credential references was ever retired in this tenant. */
export const noTargetTombstone = (refs: string[]): Check =>
  tenantCheck(
    'lineage',
    `NOT EXISTS (SELECT 1 FROM pass_credential_tombstones dead
      WHERE dead.org_id = {org} AND dead.mode = {mode}
        AND dead.credential_hash IN (SELECT value FROM json_each(?)))`,
    [JSON.stringify(refs)],
  );

/** The pass's signing identity is at the revision the artifact was built under. */
export const identityRevision = (passId: string, revision: number): Check =>
  tenantCheck(
    'config',
    `EXISTS (SELECT 1 FROM passes p JOIN signing_identities si ON si.id = p.identity_id
      WHERE p.id = ? AND p.org_id = {org} AND (si.org_id IS NULL OR si.org_id = {org})
        AND si.revision = ?)`,
    [passId, revision],
  );

interface ConnectionBinding {
  connectionId: string;
  externalRef: string | null;
  generation: number;
  mode?: string | undefined;
}

/** The pass is the connector's live, active pass and the connection is enabled at the captured generation. */
export function connectionBound(passId: string, c: ConnectionBinding): Check[] {
  const connection: Record<string, SqlValue> = { enabled: 1, generation: c.generation };
  if (c.mode !== undefined) connection.mode = c.mode;
  return [
    rowIs(
      'passes',
      passId,
      {
        connection_id: c.connectionId,
        external_ref: c.externalRef,
        status: 'active',
        removed_at: null,
        deleted_at: null,
      },
      'config',
    ),
    rowIs('connections', c.connectionId, connection, 'config'),
  ];
}

/** The connector's whole captured context (the old `connectionPassPredicate`), at the start. */
export function connectionContext(c: ConnectionPassContext): Check[] {
  const pass: Record<string, SqlValue> = {
    status: c.status,
    version: c.expectedVersion,
    connection_id: c.connectionId,
    external_ref: c.externalRef,
    owner_user_id: c.ownerUserId,
    link_generation: c.linkGeneration,
    identity_id: c.identityId,
    credential_generation: c.credentialGeneration,
    lifecycle_generation: c.lifecycleGeneration,
    deleted_at: null,
    removed_at: null,
    test_data_quarantined: 0,
  };
  const proof = c.retainedReleaseProof;
  if (proof) Object.assign(pass, { release_id: proof.id, template_version: proof.version });
  const binding = c.retainedBinding;
  if (binding)
    Object.assign(pass, { template_id: binding.templateId, release_id: binding.releaseId });
  if (binding) pass.template_version = binding.templateVersion;
  return [
    rowIs('passes', c.passId, pass, 'config'),
    rowIs(
      'connections',
      c.connectionId,
      { enabled: 1, generation: c.generation, mode: c.expectedConnectionMode },
      'config',
    ),
  ];
}

/** The pass's own issued release still exists and its template is not deleted (releases are immutable). */
export const releaseIssued = (releaseId: string): Check =>
  tenantCheck(
    'release',
    `EXISTS (SELECT 1 FROM template_releases r JOIN templates t ON t.id = r.template_id
      WHERE r.id = ? AND t.status != 'deleted')`,
    [releaseId],
  );

/** Stops the user's sign-in from re-attaching the pass once they removed it. */
export const attachBlockPart = (userId: string, now: number) =>
  writePart(
    'INSERT OR IGNORE INTO pass_attach_blocks (pass_id,user_id,created_at) SELECT {pass},?,? WHERE {grant}',
    [userId, now],
  );
