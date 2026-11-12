import type { JobOf } from '../../jobs/types.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { ConnectionReleaseSnapshot } from './records.ts';
import type { SyncSnapshot } from './repo-pass-snapshot.ts';
import {
  claimSnapshot,
  finishItem,
  finishNoEffect,
  parkItem,
  parkUnexpectedBinding,
  startExistingItem,
  startNewItem,
  summarizeItems,
  type WebhookItemOutcome,
} from './repo-webhook-items.ts';
import { retainedWebhookRefHash } from './webhook-claim-ref.ts';
import { existingValid, newValid, nonempty } from './webhook-retention-item-candidate.ts';
import { pendingRow, unavailableOrTerminal } from './webhook-retention-item-context.ts';

export type RetainedWebhookCandidate =
  | {
      kind: 'existing';
      snapshot: SyncSnapshot;
      templateId: string;
      releaseId: string | null;
      templateVersion: string;
      credentialKeysetCommitment: string;
    }
  | {
      kind: 'new';
      reservedPassId: string;
      orgId: string;
      connectionId: string;
      externalRef: string;
      generation: number;
      templateId: string | null;
      expectedRelease: ConnectionReleaseSnapshot;
      credentialKeysetCommitment: string;
    }
  | { kind: 'invalid'; passId: string }
  | { kind: 'no-effect' };

export interface RetainedWebhookClaim {
  retentionId: string;
  ordinal: number;
  token: string;
  revision: number;
  refHash: string;
  credentialKeysetCommitment: string;
}

type WebhookJob = JobOf<'connection.webhook'>;

type Existing = Extract<RetainedWebhookCandidate, { kind: 'existing' }>;
type New = Extract<RetainedWebhookCandidate, { kind: 'new' }>;
type Bound = Existing | New;

/** Commit both token and exact pass/reservation binding before an item can cause an effect. */
export async function startRetainedWebhookItem(
  sctx: ServiceContext,
  job: WebhookJob,
  revision: number,
  ordinal: number,
  candidate: RetainedWebhookCandidate,
): Promise<null | {
  token: string;
  revision: number;
  binding: Bound;
  credentialKeysetCommitment: string;
  reservedPassId?: string;
  retainedClaim?: RetainedWebhookClaim;
}> {
  const row = await pendingRow(sctx, job, revision);
  const ref = job.refs[ordinal];
  if (
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= row.itemCount ||
    typeof ref !== 'string'
  ) {
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  }
  const { refHash, credentialKeysetCommitment } = await retainedWebhookRefHash(
    sctx,
    row.orgId,
    row.connectionId,
    ref,
  );
  if (credentialKeysetCommitment !== row.credentialKeysetCommitment) {
    throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
  }
  const token = sctx.ids.id();
  if (row.source !== 'ingress') {
    await parkItem(sctx, row, ordinal, null, null);
    return unavailableOrTerminal(sctx, row, ordinal);
  }
  if (candidate.kind === 'no-effect') {
    if (!(await finishNoEffect(sctx, row, ordinal, ref))) {
      await parkUnexpectedBinding(
        sctx,
        row,
        ordinal,
        ref,
        refHash,
        credentialKeysetCommitment,
        null,
      );
    }
    return unavailableOrTerminal(sctx, row, ordinal);
  }
  if (candidate.kind === 'invalid') {
    const passId = nonempty(candidate.passId) ? candidate.passId : null;
    await parkUnexpectedBinding(
      sctx,
      row,
      ordinal,
      ref,
      refHash,
      credentialKeysetCommitment,
      passId ? { kind: 'existing', passId, snapshot: null } : null,
      passId,
    );
    return unavailableOrTerminal(sctx, row, ordinal);
  }
  if (candidate.kind === 'existing') {
    const snapshot = claimSnapshot(row, candidate, refHash, candidate.credentialKeysetCommitment);
    if (
      existingValid(candidate, row, ref) &&
      candidate.snapshot.transferPending === false &&
      (await startExistingItem(
        sctx,
        row,
        ordinal,
        token,
        candidate,
        snapshot,
        credentialKeysetCommitment,
      ))
    ) {
      return { token, revision, binding: candidate, credentialKeysetCommitment };
    }
    await parkItem(sctx, row, ordinal, candidate, snapshot);
    return unavailableOrTerminal(sctx, row, ordinal);
  }
  if (candidate.kind === 'new') {
    const snapshot = claimSnapshot(row, candidate, refHash, candidate.credentialKeysetCommitment);
    if (
      newValid(candidate, row, ref) &&
      (await startNewItem(
        sctx,
        row,
        ordinal,
        token,
        candidate,
        snapshot,
        refHash,
        credentialKeysetCommitment,
      ))
    ) {
      return {
        token,
        revision,
        binding: candidate,
        credentialKeysetCommitment,
        reservedPassId: candidate.reservedPassId,
        retainedClaim: {
          retentionId: row.id,
          ordinal,
          token,
          revision,
          refHash,
          credentialKeysetCommitment,
        },
      };
    }
    await parkUnexpectedBinding(
      sctx,
      row,
      ordinal,
      ref,
      refHash,
      credentialKeysetCommitment,
      newValid(candidate, row, ref)
        ? { kind: 'new', passId: candidate.reservedPassId, snapshot }
        : null,
    );
    return unavailableOrTerminal(sctx, row, ordinal);
  }
  await parkUnexpectedBinding(sctx, row, ordinal, ref, refHash, credentialKeysetCommitment, null);
  return unavailableOrTerminal(sctx, row, ordinal);
}

/** Only the holder of the exact started token can finalize an item. */
export async function finishRetainedWebhookItem(
  sctx: ServiceContext,
  job: WebhookJob,
  revision: number,
  ordinal: number,
  token: string,
  outcome: WebhookItemOutcome,
  code?: string,
): Promise<void> {
  const row = await pendingRow(sctx, job, revision);
  const credentialKeysetCommitment = await requireCredentialRefKeyset(sctx.env.DB, sctx.env);
  if (credentialKeysetCommitment !== row.credentialKeysetCommitment) {
    throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
  }
  const safeCode = code && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : null;
  if (
    !(await finishItem(sctx, row, ordinal, token, outcome, safeCode, credentialKeysetCommitment))
  ) {
    throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
  }
}

export async function summarizeRetainedWebhookItems(
  sctx: ServiceContext,
  job: WebhookJob,
  revision: number,
) {
  const row = await pendingRow(sctx, job, revision);
  const summary = await summarizeItems(sctx.env.DB, row);
  if (!summary)
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  return summary;
}
