import { ConnectionModeSchema } from '../../../shared/contracts/connections.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createGrant, createRefusal, sampleScopeCurrent } from './create-grant.ts';
import { addCreateStatements } from './create-records.ts';
import { validPassReleaseSnapshot } from './repo-release.ts';
import { permitsPassMutation } from './repo-write-authority.ts';
import { attachableOwner } from './repo-write-insert-statement.ts';
import { type RetainedIssuanceScope, validRetainedIssuance } from './repo-write-retained.ts';
import type { NewPassRow } from './repo-write-types.ts';

export { setBinding } from './repo-write-bind.ts';

/** The `pass_created` trigger records version 1 from the pending_* columns. */
export async function insertPass(
  ctx: ServiceContext,
  row: NewPassRow,
): Promise<false | { ownerUserId: string | null; revision: number }> {
  const execution = row.execution;
  if (
    !execution ||
    (execution.kind !== 'tenant' && execution.kind !== 'connection' && execution.kind !== 'system')
  )
    return false;
  const authority = execution.kind === 'tenant' ? execution.authority : undefined;
  const additionalAuthority =
    execution.kind === 'tenant' ? execution.additionalAuthority : undefined;
  const sampleScannerScope = execution.kind === 'tenant' ? execution.sampleScannerScope : undefined;
  if (
    sampleScannerScope !== undefined &&
    (row.source !== 'manual' ||
      row.mode !== 'test' ||
      additionalAuthority?.kind !== 'session' ||
      additionalAuthority.capability !== 'scanning:manage')
  )
    return false;
  if (execution.kind === 'tenant' && (!authority || !permitsPassMutation(authority))) return false;
  if (authority && (authority.orgId !== row.orgId || authority.mode !== row.mode)) return false;
  if (
    execution.kind === 'connection' &&
    (row.source !== 'connection' ||
      execution.connectionId !== row.connectionId ||
      execution.generation !== row.connectionGeneration)
  )
    return false;
  if (row.source !== 'manual' && row.source !== 'connection') return false;
  if (
    (row.connectionId !== null &&
      (row.expectedConnectionMode === undefined ||
        !ConnectionModeSchema.options.includes(row.expectedConnectionMode))) ||
    (row.connectionId === null && row.expectedConnectionMode !== undefined)
  )
    return false;
  if (
    row.source === 'connection' &&
    (typeof row.connectionId !== 'string' ||
      row.connectionId.length === 0 ||
      typeof row.connectionGeneration !== 'number' ||
      !Number.isSafeInteger(row.connectionGeneration) ||
      row.connectionGeneration <= 0)
  )
    return false;
  if (!validPassReleaseSnapshot(row.release)) return false;
  if (row.release.orgId !== null && row.release.orgId !== row.orgId) return false;
  if (
    typeof row.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.credentialKeysetCommitment)
  )
    return false;
  if (
    !Array.isArray(row.credentialRefs) ||
    row.credentialRefs.some((ref) => typeof ref !== 'string' || !/^[0-9a-f]{64}$/.test(ref))
  )
    return false;
  if ((row.reservedPassId === undefined) !== (row.retainedClaim === undefined)) return false;
  let retainedScope: RetainedIssuanceScope | undefined;
  if (row.retainedClaim !== undefined) {
    if (
      !row.retainedClaim ||
      row.retainedClaim.credentialKeysetCommitment !== row.credentialKeysetCommitment
    )
      return false;
    if (
      row.source !== 'connection' ||
      execution.kind !== 'connection' ||
      row.mode !== 'live' ||
      row.reservedPassId !== row.id ||
      !row.connectionId ||
      !row.externalRef ||
      row.connectionGeneration === null ||
      row.expectedConnectionMode === undefined
    )
      return false;
    const scope: RetainedIssuanceScope = {
      claim: row.retainedClaim,
      passId: row.id,
      orgId: row.orgId,
      connectionId: row.connectionId,
      connectionGeneration: row.connectionGeneration,
      connectionMode: row.expectedConnectionMode,
      templateId: row.templateId,
      release: row.release,
      releaseVersion: row.templateVersion,
    };
    if (!validRetainedIssuance(scope)) return false;
    retainedScope = scope;
  }
  if (additionalAuthority) {
    const additional = additionalAuthority;
    const primary = authority;
    if (
      !primary ||
      additional.kind !== primary.kind ||
      additional.orgId !== primary.orgId ||
      additional.mode !== primary.mode
    )
      return false;
    if (additional.kind === 'session') {
      if (
        primary.kind !== 'session' ||
        additional.userId !== primary.userId ||
        additional.sessionId !== primary.sessionId ||
        additional.membershipId !== primary.membershipId
      )
        return false;
    } else if (primary.kind !== 'api_key' || additional.keyId !== primary.keyId) {
      return false;
    }
  }
  if (!(await sampleScopeCurrent(ctx.env.DB, row))) return false;
  let owner = await attachableOwner(ctx.env.DB, row);
  for (let attempt = 0; ; attempt++) {
    const g = createGrant(ctx, row, retainedScope);
    try {
      const at = await addCreateStatements(ctx, g, row, owner);
      const results = await g.commit();
      const issued = (
        results[at.insert]?.results as { owner_user_id: string | null }[] | undefined
      )?.[0];
      const seen = (
        results[at.revision]?.results as
          | { owner_user_id: string | null; revision: number }[]
          | undefined
      )?.[0];
      return issued && seen
        ? { ownerUserId: issued.owner_user_id, revision: seen.revision }
        : false;
    } catch (error) {
      const reason = createRefusal(error);
      // A lost race is diagnosed by the caller. A lost org or actor on a request is a 403.
      if (
        reason === null ||
        (execution.kind === 'tenant' && (reason === 'org' || reason === 'actor'))
      )
        throw error;
      if (reason !== 'stale' || attempt >= 2) return false;
      // The holder's account moved between the read and the insert: take the new owner once.
      const current = await attachableOwner(ctx.env.DB, row);
      if (current === owner) return false;
      owner = current;
    }
  }
}
