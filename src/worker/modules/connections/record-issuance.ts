import type { Json } from '../../../shared/contracts/common.ts';
import { AppError, ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ConnectionDeps, getDeps } from './deps.ts';
import { releaseBlockCode } from './record-outcomes.ts';
import type { Applied, ApplyIncomingOptions } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { hasBinding, templateScope } from './repo-passes.ts';

export type ReleaseBlockCode = 'TEMPLATE_RELEASE_REQUIRED' | 'TEMPLATE_RELEASE_CONFLICT';
export type ConnectionReleaseSnapshot =
  | { kind: 'approved'; id: string; generation: number; version: string }
  | { kind: 'blocked'; code: ReleaseBlockCode }
  | null;

/** Issuance rejected changed content before commit and cleaned any staged artifact. */
export class ReleaseContentRetryError extends ConflictError {
  constructor() {
    super('The approved template content changed.', 'TEMPLATE_CONTENT_CHANGED');
  }
}

/** Capture once before fetching; never adopt a later release for this run. */
export async function captureConnectionRelease(
  sctx: ServiceContext,
  conn: ConnectionRow,
): Promise<ConnectionReleaseSnapshot> {
  if (!conn.autoCreate || !conn.defaultTemplateId) return null;
  try {
    const release = await getDeps().requireApprovedRelease(
      sctx,
      conn.defaultTemplateId,
      conn.orgId,
      'live',
      'apple',
    );
    return {
      kind: 'approved',
      id: release.id,
      generation: release.generation,
      version: release.version,
    };
  } catch (error) {
    const code = releaseBlockCode(error);
    if (code) return { kind: 'blocked', code };
    throw error;
  }
}

/** Issue an unlinked record using the release and authority captured before its fetch. */
export async function createIncomingPass(
  sctx: ServiceContext,
  conn: ConnectionRow,
  ref: string,
  options: ApplyIncomingOptions,
  fields: Record<string, Json>,
  holderEmail: string | null,
  deps: ConnectionDeps,
  db: D1Database,
  fenced: () => Promise<boolean>,
): Promise<Applied> {
  if (!conn.autoCreate || !conn.defaultTemplateId) return { outcome: 'unlinked' };
  if (await hasBinding(db, conn.orgId, conn.id, ref)) {
    return { outcome: options.retainedReservedPassId === undefined ? 'unlinked' : 'fenced' };
  }
  const template = await templateScope(db, conn.defaultTemplateId);
  if (template?.status !== 'active' || (template.orgId !== null && template.orgId !== conn.orgId)) {
    throw new ValidationError('The connection template is unavailable.', [], 'TEMPLATE_NOT_FOUND');
  }
  const release = options.release;
  if (!release || release.kind === 'blocked') {
    return {
      outcome: 'release_blocked',
      releaseBlocked: release?.code ?? 'TEMPLATE_RELEASE_REQUIRED',
      effectFree: true,
    };
  }
  if (await fenced()) return { outcome: 'fenced' };
  try {
    const created = await deps.createPassFromConnection(sctx, {
      orgId: conn.orgId,
      mode: 'live',
      templateId: conn.defaultTemplateId,
      expectedRelease: {
        id: release.id,
        generation: release.generation,
        version: release.version,
      },
      connectionId: conn.id,
      credentialKeysetCommitment: options.credentialKeysetCommitment,
      generation: options.generation,
      expectedConnectionMode: conn.mode,
      externalRef: ref,
      fields,
      holderEmail,
      sendEmail: conn.autoEmail && holderEmail !== null,
      ...(options.retainedReservedPassId !== undefined && options.retainedClaim
        ? { reservedPassId: options.retainedReservedPassId, retainedClaim: options.retainedClaim }
        : {}),
    });
    if (
      options.retainedReservedPassId !== undefined &&
      created.passId !== options.retainedReservedPassId
    ) {
      return { outcome: 'fenced' };
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'TEMPLATE_CONTENT_CHANGED') {
      throw new ReleaseContentRetryError();
    }
    throw error;
  }
  return { outcome: 'created' };
}
