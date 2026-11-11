import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { syncWorkflowKeysetMatches } from './repo-sync.ts';
import type { StartResult } from './sync.ts';
import { syncKeysetCurrent } from './sync-context.ts';

/** Replays must match both the runtime key and the keyset recorded at enqueue. */
export async function assertSyncAuthority(
  sctx: ServiceContext,
  p: Parameters<typeof syncWorkflowKeysetMatches>[1],
): Promise<void> {
  if (
    !(await syncKeysetCurrent(sctx, p.credentialKeysetCommitment)) ||
    !(await syncWorkflowKeysetMatches(sctx.env.DB, p))
  ) {
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  }
}

export function assertSyncStart(
  start: StartResult,
  p: { credentialKeysetCommitment: string },
): void {
  if (
    !start ||
    typeof start !== 'object' ||
    typeof start.ok !== 'boolean' ||
    !Number.isFinite(start.startedAt) ||
    (start.mode !== undefined &&
      !['poll', 'webhook', 'hybrid', 'manual', 'snapshot'].includes(start.mode)) ||
    (start.ok &&
      (start.mode === undefined ||
        typeof start.useList !== 'boolean' ||
        (start.cursor !== null && typeof start.cursor !== 'string') ||
        start.release === undefined))
  )
    throw new UnavailableError('Sync context is unavailable.', 'STALE_CONTEXT');
  if (start.credentialKeysetCommitment !== p.credentialKeysetCommitment)
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
}
