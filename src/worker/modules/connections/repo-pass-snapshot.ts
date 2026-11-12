import { ConnectionModeSchema } from '../../../shared/contracts/connections.ts';
import type { Grant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rawCheck } from '../../platform/authority-checks.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { syncKeysetCurrent } from './keyset-current.ts';
import type { Mode as ConnectionMode } from './repo.ts';
import { commitOrNull, connectionGrant, connectionIs, rowCount } from './repo-grants.ts';
import {
  type PassReleaseBinding,
  type SyncPass,
  validCredentialKeysetCommitment,
  validPassReleaseBinding,
} from './repo-passes.ts';

export type KeysetBoundPassRelease = PassReleaseBinding & { credentialKeysetCommitment: string };

/** The pass and connection values captured before an upstream request. */
export interface SyncSnapshot {
  passId: string;
  orgId: string;
  mode: 'live';
  status: 'active';
  expectedVersion: number;
  /** The pass row_version read with the snapshot: the row-level fence for the write. */
  expectedRowVersion: number;
  identityId: string;
  credentialGeneration: number;
  lifecycleGeneration: number;
  credentialKeysetCommitment: string;
  transferPending: boolean;
  ownerUserId: string | null;
  linkGeneration: number;
  connectionId: string;
  externalRef: string;
  generation: number;
  /** The connection mode captured when the work began. */
  expectedConnectionMode: ConnectionMode;
  retainedBinding?: KeysetBoundPassRelease;
}

/** Unknown or pending credential authority must never be used for an effect. */
export function validSyncEpochs(
  p: Pick<
    SyncSnapshot,
    | 'credentialGeneration'
    | 'lifecycleGeneration'
    | 'transferPending'
    | 'credentialKeysetCommitment'
  >,
): boolean {
  return (
    Number.isSafeInteger(p.credentialGeneration) &&
    p.credentialGeneration > 0 &&
    Number.isSafeInteger(p.lifecycleGeneration) &&
    p.lifecycleGeneration >= 0 &&
    p.transferPending === false &&
    validCredentialKeysetCommitment(p.credentialKeysetCommitment)
  );
}

/** Compare a fresh batch read to the original authority without adopting a newer snapshot. */
export function sameSyncPass(expected: SyncPass, current: SyncPass | null | undefined): boolean {
  return (
    !!current &&
    validSyncEpochs(expected) &&
    validSyncEpochs(current) &&
    typeof expected.id === 'string' &&
    !!expected.id &&
    typeof expected.orgId === 'string' &&
    !!expected.orgId &&
    typeof expected.identityId === 'string' &&
    !!expected.identityId &&
    Number.isSafeInteger(expected.version) &&
    expected.version > 0 &&
    Number.isSafeInteger(expected.linkGeneration) &&
    expected.linkGeneration > 0 &&
    typeof expected.connectionId === 'string' &&
    !!expected.connectionId &&
    typeof expected.externalRef === 'string' &&
    !!expected.externalRef &&
    (expected.ownerUserId === null || typeof expected.ownerUserId === 'string') &&
    validPassReleaseBinding(expected) &&
    expected.mode === 'live' &&
    expected.status === 'active' &&
    expected.deletedAt === null &&
    expected.removedAt === null &&
    current.deletedAt === null &&
    current.removedAt === null &&
    current.id === expected.id &&
    current.orgId === expected.orgId &&
    current.mode === expected.mode &&
    current.status === expected.status &&
    current.version === expected.version &&
    current.identityId === expected.identityId &&
    current.credentialGeneration === expected.credentialGeneration &&
    current.lifecycleGeneration === expected.lifecycleGeneration &&
    current.credentialKeysetCommitment === expected.credentialKeysetCommitment &&
    current.ownerUserId === expected.ownerUserId &&
    current.linkGeneration === expected.linkGeneration &&
    current.connectionId === expected.connectionId &&
    current.externalRef === expected.externalRef &&
    current.templateId === expected.templateId &&
    current.releaseId === expected.releaseId &&
    current.templateVersion === expected.templateVersion
  );
}

/** The values every sync statement over a pass compares: the pass is still this connection's active Live incarnation. */
function passLineage(p: SyncSnapshot, binding?: KeysetBoundPassRelease): Record<string, SqlValue> {
  return {
    id: p.passId,
    connection_id: p.connectionId,
    external_ref: p.externalRef,
    identity_id: p.identityId,
    status: 'active',
    credential_generation: p.credentialGeneration,
    lifecycle_generation: p.lifecycleGeneration,
    deleted_at: null,
    removed_at: null,
    test_data_quarantined: 0,
    ...(binding
      ? {
          template_id: binding.templateId,
          release_id: binding.releaseId,
          template_version: binding.templateVersion,
        }
      : {}),
  };
}

type Retained = { binding: KeysetBoundPassRelease | undefined };

/** Retained work stays bound to the release its claim captured. */
function retainedOf(p: SyncSnapshot): Retained | null {
  if (
    !ConnectionModeSchema.options.includes(p.expectedConnectionMode) ||
    !validCredentialKeysetCommitment(p.credentialKeysetCommitment)
  )
    return null;
  const binding = p.retainedBinding;
  if (
    binding !== undefined &&
    (!binding ||
      !validPassReleaseBinding(binding) ||
      binding.credentialKeysetCommitment !== p.credentialKeysetCommitment)
  )
    return null;
  return { binding };
}

function syncChecks(p: SyncSnapshot, retained: Retained): Check[] {
  return [
    connectionIs({
      id: p.connectionId,
      generation: p.generation,
      syncMode: p.expectedConnectionMode,
      enabled: true,
    }),
    exactlyOne('passes', passLineage(p, retained.binding), undefined, 'lineage'),
    rawCheck(
      'lineage',
      "NOT EXISTS (SELECT 1 FROM pass_credential_transfers pct WHERE pct.pass_id = ? AND pct.state = 'pending')",
      [p.passId],
    ),
  ];
}

/** Sync metadata is volatile: it never moves the pass epoch and never waits on a content edit. */
async function writePassSync(
  ctx: ServiceContext,
  p: SyncSnapshot,
  action: string,
  write: Pick<Parameters<Grant['update']>[1], 'set' | 'inc'>,
): Promise<boolean> {
  if (typeof p.identityId !== 'string' || !p.identityId || !validSyncEpochs(p)) return false;
  const retained = retainedOf(p);
  if (!retained || !(await syncKeysetCurrent(ctx, p.credentialKeysetCommitment))) return false;
  const actor = { orgId: p.orgId };
  const g = connectionGrant(ctx, actor, action, syncChecks(p, retained), p.passId);
  g.update('passes', { ...write, where: { id: p.passId }, returning: ['id'] });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}

export function markPassSynced(
  ctx: ServiceContext,
  p: SyncSnapshot & { now: number; nextSyncAt: number | null },
): Promise<boolean> {
  return writePassSync(ctx, p, 'pass.synced', {
    set: {
      last_synced_at: p.now,
      sync_error_code: null,
      sync_failures: 0,
      next_sync_at: p.nextSyncAt,
    },
  });
}

export function markPassSyncError(
  ctx: ServiceContext,
  p: SyncSnapshot & { code: string; nextSyncAt: number | null },
): Promise<boolean> {
  return writePassSync(ctx, p, 'pass.sync_error', {
    set: { sync_error_code: p.code, next_sync_at: p.nextSyncAt },
    inc: ['sync_failures'],
  });
}
