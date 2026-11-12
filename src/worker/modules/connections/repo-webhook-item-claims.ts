import { type Check, exactlyOne, rawCheck, releaseHead } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  commitOrNull,
  connectionGrant,
  connectionIs,
  itemReleaseMatches,
  retentionIs,
  rowCount,
} from './repo-grants.ts';
import type { RetainedRow } from './repo-webhook-retention.ts';
import type { RetainedWebhookCandidate } from './webhook-retention-items.ts';

type ExistingCandidate = Extract<RetainedWebhookCandidate, { kind: 'existing' }>;
type NewCandidate = Extract<RetainedWebhookCandidate, { kind: 'new' }>;

/** The reference remains encrypted in the retained payload; this snapshot stores its keyed commitment. */
export function claimSnapshot(
  row: RetainedRow,
  candidate: ExistingCandidate | NewCandidate,
  refHash: string,
  credentialKeysetCommitment: string,
): string {
  if (candidate.kind === 'new')
    return JSON.stringify({
      kind: candidate.kind,
      passId: candidate.reservedPassId,
      orgId: candidate.orgId,
      connectionId: candidate.connectionId,
      generation: candidate.generation,
      connectionMode: row.connectionMode,
      refHash,
      credentialKeysetCommitment,
      templateId: candidate.templateId,
      expectedRelease: candidate.expectedRelease,
    });
  const s = candidate.snapshot;
  return JSON.stringify({
    kind: candidate.kind,
    passId: s.passId,
    orgId: s.orgId,
    connectionId: s.connectionId,
    generation: s.generation,
    connectionMode: row.connectionMode,
    refHash,
    credentialKeysetCommitment,
    mode: s.mode,
    status: s.status,
    rowVersion: s.expectedRowVersion,
    identityId: s.identityId,
    credentialGeneration: s.credentialGeneration,
    lifecycleGeneration: s.lifecycleGeneration,
    transferPending: s.transferPending,
    ownerUserId: s.ownerUserId,
    linkGeneration: s.linkGeneration,
    templateId: candidate.templateId,
    releaseId: candidate.releaseId,
    templateVersion: candidate.templateVersion,
  });
}

/** The pass is the exact incarnation the claim names: bound to this connection, active, no transfer pending. */
function passIs(passId: string, connectionId: string, c: ExistingCandidate): Check[] {
  const s = c.snapshot;
  return [
    exactlyOne(
      'passes',
      {
        id: passId,
        connection_id: connectionId,
        external_ref: s.externalRef,
        row_version: s.expectedRowVersion,
        identity_id: s.identityId,
        credential_generation: s.credentialGeneration,
        lifecycle_generation: s.lifecycleGeneration,
        owner_user_id: s.ownerUserId,
        link_generation: s.linkGeneration,
        template_id: c.templateId,
        template_version: c.templateVersion,
        release_id: c.releaseId,
        status: 'active',
        deleted_at: null,
        removed_at: null,
        test_data_quarantined: 0,
      },
      undefined,
      'lineage',
    ),
    rawCheck(
      'lineage',
      "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
      [passId],
    ),
  ];
}

/** Bind and claim the exact pass incarnation in the same transaction as every authority check. */
export async function startExistingItem(
  ctx: ServiceContext,
  row: RetainedRow,
  ordinal: number,
  token: string,
  candidate: ExistingCandidate,
  snapshot: string,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  const s = candidate.snapshot;
  if (s.orgId !== row.orgId || s.connectionId !== row.connectionId) return false;
  const actor = { orgId: row.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.item_claim',
    [
      connectionIs({
        id: s.connectionId,
        generation: s.generation,
        syncMode: row.connectionMode,
        enabled: true,
      }),
      retentionIs(row.id, {
        connection_id: s.connectionId,
        generation: s.generation,
        state: 'pending',
        revision: row.revision,
        credential_keyset_commitment: credentialKeysetCommitment,
        source: 'ingress',
        snapshot_known: 1,
      }),
      itemReleaseMatches(row.id, ordinal),
      rawCheck(
        'retention',
        `EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.retention_id = ? AND i.ordinal = ?
          AND (i.claim_kind IS NULL OR i.claim_kind = 'existing')
          AND (i.claim_pass_id IS NULL OR i.claim_pass_id = ?)
          AND (i.claim_snapshot IS NULL OR i.claim_snapshot = ?))`,
        [row.id, ordinal, s.passId, snapshot],
      ),
      ...passIs(s.passId, s.connectionId, candidate),
    ],
    row.id,
  );
  g.joined('connection_webhook_items', {
    set: {
      state: 'started',
      token,
      error_code: null,
      claim_kind: 'existing',
      claim_pass_id: s.passId,
      claim_revision: row.revision,
      claim_snapshot: snapshot,
    },
    where: {
      retention_id: row.id,
      ordinal,
      state: 'pending',
      claim_prior_unbound: 0,
      prior_unknown: 0,
    },
    returning: ['ordinal'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}

/** Reserve a server-generated pass ID before issuance; only proven effect-free retries may replace it. */
export async function startNewItem(
  ctx: ServiceContext,
  row: RetainedRow,
  ordinal: number,
  token: string,
  candidate: NewCandidate,
  snapshot: string,
  refHash: string,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  if (candidate.orgId !== row.orgId || candidate.connectionId !== row.connectionId) return false;
  const release = candidate.expectedRelease?.kind === 'approved' ? candidate.expectedRelease : null;
  if (release && !candidate.templateId) return false;
  const actor = { orgId: row.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.item_reserve',
    [
      connectionIs({
        id: candidate.connectionId,
        generation: candidate.generation,
        syncMode: row.connectionMode,
        enabled: true,
      }),
      exactlyOne(
        'connections',
        { id: candidate.connectionId, auto_create: 1, default_template_id: candidate.templateId },
        undefined,
        'config',
      ),
      retentionIs(row.id, {
        source: 'ingress',
        snapshot_known: 1,
        connection_id: candidate.connectionId,
        generation: candidate.generation,
        state: 'pending',
        revision: row.revision,
        credential_keyset_commitment: credentialKeysetCommitment,
      }),
      itemReleaseMatches(row.id, ordinal),
      rawCheck(
        'retention',
        `EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.retention_id = ? AND i.ordinal = ?
          AND (i.claim_kind IS NULL OR (i.claim_kind = 'new'
            AND json_extract(i.claim_snapshot, '$.refHash') = ?
            AND json_extract(i.claim_snapshot, '$.orgId') = ?
            AND json_extract(i.claim_snapshot, '$.connectionId') = ?
            AND json_extract(i.claim_snapshot, '$.generation') = ?
            AND json_extract(i.claim_snapshot, '$.credentialKeysetCommitment') = ?
            AND NOT EXISTS (SELECT 1 FROM passes previous WHERE previous.id = i.claim_pass_id))))`,
        [
          row.id,
          ordinal,
          refHash,
          candidate.orgId,
          candidate.connectionId,
          candidate.generation,
          credentialKeysetCommitment,
        ],
      ),
      rawCheck('lineage', 'NOT EXISTS (SELECT 1 FROM passes reserved WHERE reserved.id = ?)', [
        candidate.reservedPassId,
      ]),
      rawCheck(
        'lineage',
        'NOT EXISTS (SELECT 1 FROM passes linked WHERE linked.connection_id = ? AND linked.external_ref = ?)',
        [candidate.connectionId, candidate.externalRef],
      ),
      ...(release && candidate.templateId
        ? [
            rawCheck(
              'release',
              `EXISTS (SELECT 1 FROM connection_webhook_retention r WHERE r.id = ?
                AND json_extract(r.release_snapshot, '$.kind') = 'approved'
                AND json_extract(r.release_snapshot, '$.id') = ?
                AND json_extract(r.release_snapshot, '$.generation') = ?
                AND json_extract(r.release_snapshot, '$.version') = ?)`,
              [row.id, release.id, release.generation, release.version],
            ),
            releaseHead(candidate.templateId, 'live', 'apple', release.id),
          ]
        : []),
    ],
    row.id,
  );
  g.joined('connection_webhook_items', {
    set: {
      state: 'started',
      token,
      error_code: null,
      claim_kind: 'new',
      claim_pass_id: candidate.reservedPassId,
      claim_revision: row.revision,
      claim_snapshot: snapshot,
    },
    where: {
      retention_id: row.id,
      ordinal,
      state: 'pending',
      prior_unknown: 0,
      claim_prior_unbound: 0,
    },
    returning: ['ordinal'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}
