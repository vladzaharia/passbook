import { ZodError } from 'zod';
import { parseIsoDate } from '../../../passkit/schema/util.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import type { PreparedAssetGrant } from './asset-types.ts';
import { assetBaseUrl, assetWalletActive, preparePhotoGrant } from './assets.ts';
import type { LiveRecipient } from './live-auth.ts';
import {
  LIVE_ROW_TTL_MS,
  liveActorDeadline,
  liveActorFreshLifetimeFence,
} from './live-lifetime.ts';
import { livePassCommitmentValid } from './live-pass-commitment.ts';
import type { LivePassSnapshot, LiveSourceProof } from './live-provenance.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { photoPolicyForResolved, scannerCandidateAllowed } from './member-photo.ts';
import { scanIdentity } from './projection-privacy.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import {
  type LiveDisclosureCsrfResults,
  prepareLiveDisclosurePredicates,
} from './repo-live-authority.ts';
import { liveRowUnexpiredPredicate } from './repo-live-render-plan.ts';
import { scanTemplateSnapshotPredicate } from './repo-live-template-snapshot.ts';
import { type Candidate, candidatesOf } from './repo-lookup.ts';
import { foundOf } from './resolve.ts';

type Predicate = { sql: string; params: readonly SqlValue[] };

export interface PreparedLiveRow {
  visible: ScanLiveRow | null;
  visibleFences: readonly Predicate[] | null;
  fallback: ScanLiveRow | null;
  expiresAt: number;
  /** Inclusive expiry of the original Wallet snapshot; fallback authority is separate. */
  visibleUntil: number;
  freshAt(now: number): readonly Predicate[] | null;
  fallbackFences: readonly Predicate[] | null;
  grant: {
    plan: PreparedAssetGrant;
    statementsAt(now: number, fresh: readonly Predicate[]): D1PreparedStatement[];
    actor: ScanActor;
    passId: string;
  } | null;
}

/** Construct the public shape explicitly, never copying cached identity or internal fields. */
function redactedRow(row: ScanLiveRow, customer: boolean, scannerName = ''): ScanLiveRow {
  return {
    id: row.id,
    at: row.at,
    scannerId: row.scannerId,
    scannerName: customer ? '' : scannerName,
    passId: null,
    holder: null,
    photoUrl: null,
    kind: row.kind,
    direction: row.direction,
    label:
      row.kind === 'ok'
        ? row.direction === 'out'
          ? 'Checked out'
          : 'Checked in'
        : row.kind === 'ready'
          ? customer
            ? 'Please wait'
            : 'Choose an action'
          : customer
            ? 'Please see the desk'
            : row.kind === 'undo'
              ? 'Undone'
              : row.kind === 'heads_up'
                ? 'Check required'
                : 'Not accepted',
    presented: row.presented,
  };
}

export function livePhotoUrl(
  actor: ScanActor,
  passId: string,
  grant: string,
  event: string,
): string {
  const params = new URLSearchParams({ g: grant, event });
  if (actor.principal === 'admin' && actor.scanner) {
    params.set('orgId', actor.orgId);
    params.set('setupId', actor.scanner.id);
    params.set('timeZone', actor.timeZone);
  }
  return `${assetBaseUrl(passId).replace('/passes/', '/live/passes/')}member.png?${params}`;
}

/** Prepare all projection and grant fences without another D1 acquisition. */
export async function prepareLiveRow(
  ctx: ServiceContext,
  recipient: LiveRecipient,
  row: ScanLiveRow,
  proof: LiveSourceProof,
  sourceId: string,
  candidateResult: D1Result | undefined,
  csrfResults: LiveDisclosureCsrfResults,
  sameSnapshot: (candidate: Candidate, snapshot: LivePassSnapshot | null) => boolean,
): Promise<PreparedLiveRow | null> {
  const customer = recipient.actor.scanner?.deviceRole === 'customer';
  const fallbackRow = redactedRow(row, customer, proof.actor.name);
  const fallbackFences = await prepareLiveDisclosurePredicates(
    ctx,
    {
      source: proof.actor,
      recipient,
      credentialContext: proof.credentialContext,
      candidate: null,
      requirePhoto: false,
      sameModeOnly: row.passId !== null,
    },
    csrfResults,
  );
  const expiresAt = Math.min(
    row.at + LIVE_ROW_TTL_MS,
    recipient.attachment.expiresAt,
    liveActorDeadline(proof.actor, csrfResults.sourceResult),
    liveActorDeadline(recipient.actor, csrfResults.recipientResult),
  );
  const fallback: PreparedLiveRow = {
    expiresAt,
    visibleUntil: Infinity,
    visible: null,
    visibleFences: null,
    fallback: fallbackRow,
    fallbackFences,
    grant: null,
    freshAt: (now) => {
      const source = liveActorFreshLifetimeFence(proof.actor, now);
      const screen = liveActorFreshLifetimeFence(recipient.actor, now);
      return source && screen && Number.isSafeInteger(expiresAt)
        ? [source, screen, liveRowUnexpiredPredicate(now, expiresAt)]
        : null;
    },
  };
  if (!row.passId) return fallbackFences ? fallback : null;

  try {
    if (candidateResult?.results?.length !== 1) return fallback;
    const loadedRows = candidatesOf(candidateResult);
    const loaded = loadedRows.length === 1 ? loadedRows[0] : null;
    const evaluated = proof.passSnapshot;
    if (
      !loaded ||
      loaded.pass.id !== row.passId ||
      !evaluated ||
      loaded.credentialKeysetCommitment !== evaluated.credentialKeysetCommitment
    )
      return fallback;
    // A by-ID acquisition has no presented input: carry only the original sealed refs.
    const candidate: Candidate = {
      ...loaded,
      credentialTombstoneRefs: proof.credentialContext.credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs: proof.credentialContext.otherModeCredentialTombstoneRefs,
    };
    if (
      !assetWalletActive(candidate, ctx.clock.now()) ||
      !sameSnapshot(candidate, evaluated) ||
      !(await livePassCommitmentValid(ctx.env, candidate, evaluated.passCommitment))
    )
      return fallback;
    // The commitment binds this re-read to the exact original Candidate.templateSnapshot.
    const templates = await verifyLiveTemplateSnapshot(
      ctx,
      candidate,
      candidate.templateSnapshot,
      'commit',
    );
    if (!templates) return fallback;
    const found = await foundOf(ctx, candidate, undefined, { verifiedTemplates: templates });
    if (
      !found ||
      found.template.version !== candidate.pass.templateVersion ||
      found.activePolicy.version !== candidate.activeTemplateVersion ||
      found.activePolicy.version !==
        (candidate.activeReleaseVersion ?? candidate.pass.templateVersion) ||
      !scannerCandidateAllowed(proof.actor, candidate, found.passJson, ctx.clock.now()) ||
      !scannerCandidateAllowed(recipient.actor, candidate, found.passJson, ctx.clock.now())
    )
      return fallback;
    const authority = {
      source: proof.actor,
      recipient,
      credentialContext: proof.credentialContext,
      candidate,
      requirePhoto: false,
      extra: () => [scanTemplateSnapshotPredicate(candidate, candidate.templateSnapshot, 'commit')],
    };
    const visibleFences = await prepareLiveDisclosurePredicates(ctx, authority, csrfResults);
    if (!visibleFences) return fallback;
    const visibleUntil = parseIsoDate(found.passJson.expirationDate) ?? Infinity;
    if (customer)
      return { ...fallback, visible: redactedRow(row, true), visibleFences, visibleUntil };

    // A staffless monitor borrows the source role only for visibility, never authority.
    const viewer =
      recipient.actor.role === null
        ? { ...recipient.actor, role: proof.actor.role }
        : recipient.actor;
    const sourceTitle = scanIdentity(found, proof.actor).title;
    const viewerTitle = scanIdentity(found, viewer).title;
    const holder = sourceTitle && sourceTitle === viewerTitle ? sourceTitle.slice(0, 40) : null;
    const visible = { ...redactedRow(row, false, proof.actor.name), passId: row.passId, holder };
    const prepared: PreparedLiveRow = { ...fallback, visible, visibleFences, visibleUntil };
    if (
      !photoPolicyForResolved(
        proof.actor,
        candidate,
        templates.pinned,
        templates.active,
        ctx.clock.now(),
      ) ||
      !photoPolicyForResolved(
        recipient.actor,
        candidate,
        templates.pinned,
        templates.active,
        ctx.clock.now(),
        proof.actor.role,
      )
    )
      return prepared;
    const plan = await preparePhotoGrant(
      ctx,
      recipient.actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      { sourceId, eventId: row.id, actor: proof.actor },
    );
    if (!plan) return prepared;
    const photoFences = await prepareLiveDisclosurePredicates(
      ctx,
      { ...authority, requirePhoto: true },
      csrfResults,
    );
    if (!photoFences) return prepared;
    const insertion = await prepareAssetGrantInsertion(
      ctx,
      plan,
      {
        source: csrfResults.sourceResult,
        recipient: csrfResults.recipientResult,
      },
      candidate,
    );
    return {
      ...prepared,
      grant: {
        plan,
        statementsAt: (now, fresh) => insertion(now, [...photoFences, ...fresh]),
        actor: recipient.actor,
        passId: row.passId,
      },
    };
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return fallback;
    throw error;
  }
}
