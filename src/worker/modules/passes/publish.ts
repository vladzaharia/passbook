import type { Personalization } from '../../../passkit/types.ts';
import type { PassSource } from '../../../shared/contracts/passes.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { HolderPrincipal } from '../../platform/authority-principal.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { onChannelsMaybeChanged } from '../channels/capability.ts';
import { queueLentWindow } from '../nfc/lent-window.ts';
import { ensureCredentialRefKeysetWith, requireCredentialRefKeyset } from './credential-keyset.ts';
import type { TenantPassWrite } from './http.ts';
import { publishChangedAttempt } from './publish-flow-changed.ts';
import { type PublishReleaseState, preparePublishAttempt } from './publish-flow-prepare.ts';
import { publishUnchangedAttempt } from './publish-flow-unchanged.ts';
import { capturePublishSnapshot, type PublishSnapshotState } from './publish-service-snapshot.ts';
import type { ConnectionPassContext } from './repo-connection-context.ts';
import type { FieldSources, Pass, PassCause, PassStatus } from './repo-map.ts';
import { getPassStmt, passFromResult, transferPendingStmt } from './repo-read-pass.ts';
import type { ConnectionStateWrite } from './repo-write-publish.ts';
import type { PublishCommit } from './repo-write-publish-granted.ts';
import type { PublishRemovalSnapshot } from './repo-write-publish-snapshot.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

export const MAX_CAS_ATTEMPTS = 3;

export type { PublishCommit, PublishCommitDone } from './repo-write-publish-granted.ts';
export { PublishDeclined } from './repo-write-publish-granted.ts';

export interface Mutation {
  personalization?: Personalization;
  fieldSources?: FieldSources;
  templateVersion?: string;
  status?: PassStatus;
  externalId?: string | null;
}

export interface PublishOptions {
  passId: string;
  orgScope?: ScopeArg;
  /** Captured tenant principal; omitted for connection and system operations. */
  authority?: TenantPassWrite;
  /** The device that personalized this pass: republishes under its own grant, never a job grant. */
  holder?: HolderPrincipal;
  cause: PassCause;
  /** Why beside the cause: scan, broadcast, schedule, remove, restore or designer. */
  source?: PassSource;
  /** Stamped after `source` in the version row, so a change run can find its own write. */
  sourceRef?: string;
  actor: Actor;
  /** If-Match: a stale version fails with 412 instead of re-reading. */
  expectedVersion?: number;
  /** Release selected when a queued reissue was created. */
  expectedRelease?: { id: string; generation: number };
  /** Exact pass version and artifact reviewed by a staged lifecycle mutation. */
  expectedPass?: Pick<Pass, 'version' | 'status' | 'objectKey'>;
  /** Generation committed by an image writer when staging the exact image state. */
  expectedImageGeneration?: number;
  /** Exact staged removal state, including raw legacy prior status. */
  expectedRemoval?: PublishRemovalSnapshot;
  /** Syncs are tied to their original upstream/pass snapshot, including generation. */
  connectionContext?: ConnectionPassContext;
  expectedHolder?: Pick<Pass, 'holderEmail' | 'ownerUserId'>;
  connectionState?: ConnectionStateWrite;
  /** The org-lifecycle purge voids the passes of a closed org: its job grant may act on a closed org. */
  closedOk?: true;
  /** Publish even when the built pass is identical (re-sign). */
  force?: boolean;
  /** Set false to dispatch pushes later in one go (bulk jobs). Default true. */
  dispatch?: boolean;
  /** Derives the desired state from the freshly read row; re-run on every retry. */
  mutate?: (current: Pass) => Mutation;
  /**
   * An editor's save: true messages holders about the fields it changes, false strips every
   * changeMessage. Omit for syncs and upgrades (the template's messages stay).
   */
  notify?: boolean;
  /** With `notify`: this text replaces the template's change messages, on the first changed field only. */
  changeText?: string | ((personalization: Personalization) => string);
  /**
   * Read after `mutate`: true sends the update's message even at the daily limit. Only for a
   * message that would otherwise be lost for good (the stamp that fills a card).
   */
  budgetExempt?: () => boolean;
  /** A scan's own grant: its rows commit in the pass write's batch (no tenant `authority` then). */
  commit?: PublishCommit;
  /** Extra grant checks for deferred work (a bulk rebuild's starter must still hold the right). */
  extraChecks?: readonly Check[];
  /** Mints a new scan code in place; the pass keeps its serial, token and holder. */
  rotateScanCode?: boolean;
  /** Refuses (with this error) when a credential transfer is pending; checked in the first read trip. */
  transferPendingError?: () => Error;
}

export interface PublishResult {
  pass: Pass;
  changed: boolean;
  credentialKeysetCommitment: string;
  /** The update would have notified, but the pass is at its daily limit: it went out silent. */
  silenced?: boolean;
  /** The pass.json the commit wrote (changed publishes only). */
  passJson?: string;
}

/**
 * build -> R2 put -> D1 compare-and-swap, re-reading up to three times when another writer wins.
 * A lost race is never an error code on the pass; it only surfaces as 409 after the last attempt.
 */
export async function publishPass(
  ctx: ServiceContext,
  options: PublishOptions,
): Promise<PublishResult> {
  const snapshotState: PublishSnapshotState = {
    original: null,
    originalRemoval: null,
    originalImageGeneration: null,
  };
  const releaseState: PublishReleaseState = {
    capturedRelease: undefined,
    capturedNoReleaseHistory: false,
  };
  const db = ctx.env.DB;
  const credentialEnv = { ...ctx.env };
  if (options.connectionState && !options.connectionContext)
    throw new ConflictError('The connection context is missing.', 'PASS_CONFLICT');
  if (
    options.source === 'remove' &&
    (!options.expectedPass ||
      !options.expectedRemoval ||
      options.expectedRemoval.at === null ||
      !options.force)
  )
    throw new ConflictError(
      'The staged removal context is missing. Reload and retry.',
      'PASS_CONFLICT',
    );
  if (
    options.authority &&
    (options.authority.kind === 'session'
      ? options.authority.capability !== 'passes:operate'
      : options.authority.scope !== 'passes:write')
  )
    throw new ConflictError('Your access changed. Reload and retry.', 'PASS_CONFLICT');
  let credentialKeysetCommitment: string;
  if (options.connectionContext) {
    credentialKeysetCommitment = await requireCredentialRefKeyset(db, credentialEnv);
  } else {
    // The keyset check, the pass and the transfer check share one trip.
    const done = await ensureCredentialRefKeysetWith(db, credentialEnv, [
      getPassStmt(db, options.passId, options.orgScope ?? null),
      ...(options.transferPendingError ? [transferPendingStmt(db, options.passId)] : []),
    ]);
    credentialKeysetCommitment = done.commitment;
    if (options.transferPendingError && done.extra[1]?.results.length)
      throw options.transferPendingError();
    snapshotState.preloaded = { pass: passFromResult(done.extra[0]) };
  }
  if (
    options.connectionContext &&
    options.connectionContext.credentialKeysetCommitment !== credentialKeysetCommitment
  )
    throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const snapshot = await capturePublishSnapshot(ctx, options, snapshotState);
    if (!snapshot) continue;
    const prepared = await preparePublishAttempt(
      ctx,
      options,
      snapshot,
      releaseState,
      credentialEnv,
      credentialKeysetCommitment,
    );
    const result = prepared.identical
      ? await publishUnchangedAttempt(ctx, options, prepared)
      : await publishChangedAttempt(ctx, options, prepared, credentialEnv, attempt);
    if (result) {
      await onChannelsMaybeChanged(ctx, result.pass, snapshotState.original?.templateVersion);
      // Every path that moves a guest window (update, import, bulk change, sync) ends here. A window input may
      // not show on the pass file, so this does not wait for that file to change.
      const was = snapshotState.original;
      if (
        was &&
        (was.templateVersion !== result.pass.templateVersion ||
          JSON.stringify(was.personalization) !== JSON.stringify(result.pass.personalization))
      )
        await queueLentWindow(ctx, result.pass);
      return result;
    }
  }
  throw new ConflictError('The pass changed while publishing. Retry.', 'PASS_CONFLICT');
}
