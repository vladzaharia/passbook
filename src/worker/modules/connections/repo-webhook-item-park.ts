import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { commitOrNull, connectionGrant, retentionIs } from './repo-grants.ts';
import type { RetainedRow } from './repo-webhook-retention.ts';
import type { RetainedWebhookCandidate } from './webhook-retention-items.ts';

type ExistingCandidate = Extract<RetainedWebhookCandidate, { kind: 'existing' }>;
type NewCandidate = Extract<RetainedWebhookCandidate, { kind: 'new' }>;

const itemActor = (row: RetainedRow) => ({ orgId: row.orgId });

interface ClaimColumns {
  prior_unknown: number;
  claim_kind: string | null;
  claim_pass_id: string | null;
  claim_revision: number | null;
  claim_snapshot: string | null;
  claim_prior_unbound: number;
}

const CLAIM_SELECT =
  'prior_unknown, claim_kind, claim_pass_id, claim_revision, claim_snapshot, claim_prior_unbound';

/** The claim columns an optimistic write compares, so a concurrent claim turns it into a no-op. */
const claimWhere = (c: ClaimColumns) => ({
  claim_kind: c.claim_kind,
  claim_pass_id: c.claim_pass_id,
  claim_revision: c.claim_revision,
  claim_snapshot: c.claim_snapshot,
  claim_prior_unbound: c.claim_prior_unbound,
});

/** A failed admission is never silently discarded or rebound to a newer pass. */
export async function parkItem(
  ctx: ServiceContext,
  row: RetainedRow,
  ordinal: number,
  candidate: ExistingCandidate | NewCandidate | null,
  snapshot: string | null,
): Promise<void> {
  const passId =
    candidate?.kind === 'existing'
      ? candidate.snapshot.passId
      : (candidate?.reservedPassId ?? null);
  const current = await first<ClaimColumns>(
    ctx.env.DB,
    `SELECT ${CLAIM_SELECT} FROM connection_webhook_items WHERE retention_id = ? AND ordinal = ?`,
    [row.id, ordinal],
  );
  if (!current) return;
  const legacy = current.prior_unknown === 1;
  const bound = current.claim_pass_id ?? (legacy ? null : passId);
  const actor = itemActor(row);
  const g = connectionGrant(ctx, actor, 'webhook.item_park', [], row.id);
  g.joined('connection_webhook_items', {
    set: {
      state: 'uncertain',
      token: null,
      error_code: legacy ? 'WEBHOOK_LEGACY_BINDING_CHANGED' : 'WEBHOOK_BINDING_CHANGED',
      claim_kind: current.claim_kind ?? (legacy ? 'existing' : (candidate?.kind ?? null)),
      claim_pass_id: bound,
      claim_revision: current.claim_revision ?? row.revision,
      claim_snapshot: current.claim_snapshot ?? snapshot,
      claim_prior_unbound: bound === null ? 1 : current.claim_prior_unbound,
    },
    where: { retention_id: row.id, ordinal, state: 'pending', ...claimWhere(current) },
  });
  await commitOrNull(g, actor);
}

/** Old pending admissions lacking keyset provenance are retained, never applied. */
export async function parkUnprovenLegacyItems(
  ctx: ServiceContext,
  row: RetainedRow,
): Promise<void> {
  const pending = await all<ClaimColumns & { ordinal: number }>(
    ctx.env.DB,
    `SELECT ordinal, ${CLAIM_SELECT} FROM connection_webhook_items
     WHERE retention_id = ? AND state = 'pending'`,
    [row.id],
  );
  if (pending.length === 0) return;
  const actor = itemActor(row);
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.item_park_legacy',
    [
      retentionIs(row.id, {
        source: 'legacy',
        revision: row.revision,
        credential_keyset_commitment: null,
      }),
    ],
    row.id,
  );
  for (const item of pending) {
    const bound = item.claim_pass_id;
    g.joined('connection_webhook_items', {
      set: {
        state: 'uncertain',
        token: null,
        error_code: 'WEBHOOK_LEGACY_BINDING_CHANGED',
        claim_pass_id: bound,
        claim_kind: bound === null ? item.claim_kind : 'existing',
        claim_prior_unbound: bound === null ? 1 : item.claim_prior_unbound,
      },
      where: {
        retention_id: row.id,
        ordinal: item.ordinal,
        state: 'pending',
        ...claimWhere(item),
      },
    });
  }
  await commitOrNull(g, actor);
}

interface BoundPass {
  id: string;
  org_id: string;
  connection_id: string;
  mode: string;
  status: string;
  version: number;
  identity_id: string;
  credential_generation: number;
  lifecycle_generation: number;
  owner_user_id: string | null;
  link_generation: number;
  template_id: string;
  release_id: string | null;
  template_version: number;
  transfer_pending: number;
}

/** Capture any previously unseen binding without trusting a filtered prefetch. */
export async function parkUnexpectedBinding(
  ctx: ServiceContext,
  row: RetainedRow,
  ordinal: number,
  ref: string,
  refHash: string,
  credentialKeysetCommitment: string,
  fallback: { kind: 'new' | 'existing'; passId: string; snapshot: string | null } | null,
  expectedPassId: string | null = null,
): Promise<void> {
  const db = ctx.env.DB;
  const current = await first<ClaimColumns>(
    db,
    `SELECT ${CLAIM_SELECT} FROM connection_webhook_items
     WHERE retention_id = ? AND ordinal = ? AND state = 'pending' AND prior_unknown = 0`,
    [row.id, ordinal],
  );
  if (!current) return;
  const pass = await first<BoundPass>(
    db,
    `SELECT p.id, p.org_id, p.connection_id, p.mode, p.status, p.version, p.identity_id,
       p.credential_generation, p.lifecycle_generation, p.owner_user_id, p.link_generation,
       p.template_id, p.release_id, p.template_version,
       EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending') AS transfer_pending
     FROM passes p WHERE p.org_id = ? AND p.connection_id = ? AND p.external_ref = ?
       AND (? IS NULL OR p.id = ?) LIMIT 1`,
    [row.orgId, row.connectionId, ref, expectedPassId, expectedPassId],
  );
  const claimed = current.claim_pass_id !== null;
  const snapshot = pass
    ? JSON.stringify({
        kind: 'existing',
        passId: pass.id,
        orgId: pass.org_id,
        connectionId: pass.connection_id,
        generation: row.generation,
        connectionMode: row.connectionMode,
        refHash,
        credentialKeysetCommitment,
        mode: pass.mode,
        status: pass.status,
        version: pass.version,
        identityId: pass.identity_id,
        credentialGeneration: pass.credential_generation,
        lifecycleGeneration: pass.lifecycle_generation,
        ownerUserId: pass.owner_user_id,
        linkGeneration: pass.link_generation,
        templateId: pass.template_id,
        releaseId: pass.release_id,
        templateVersion: pass.template_version,
        transferPending: pass.transfer_pending,
      })
    : null;
  const actor = itemActor(row);
  const g = connectionGrant(ctx, actor, 'webhook.item_park_binding', [], row.id);
  g.joined('connection_webhook_items', {
    set: {
      state: claimed || fallback?.passId || pass ? 'uncertain' : 'failed',
      error_code: 'WEBHOOK_BINDING_CHANGED',
      claim_kind: claimed ? current.claim_kind : pass ? 'existing' : (fallback?.kind ?? null),
      claim_snapshot: current.claim_snapshot ?? snapshot ?? fallback?.snapshot ?? null,
      claim_pass_id: current.claim_pass_id ?? pass?.id ?? fallback?.passId ?? null,
      claim_revision: current.claim_revision ?? row.revision,
    },
    where: {
      retention_id: row.id,
      ordinal,
      state: 'pending',
      prior_unknown: 0,
      ...claimWhere(current),
    },
  });
  await commitOrNull(g, actor);
}
