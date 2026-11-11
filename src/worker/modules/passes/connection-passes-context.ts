import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireApprovedRelease, type TemplateRelease } from '../templates/releases.ts';
import { requireCredentialRefKeyset } from './credential-keyset.ts';
import {
  type ConnectionPassContext,
  validConnectionPassContext,
} from './repo-connection-context.ts';
import type { Pass } from './repo-map.ts';
import { matchesConnectionPass } from './repo-read-connection.ts';
import { getPass } from './repo-read-pass.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';

export const stalePass = () =>
  new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');

export async function retainedRelease(
  ctx: ServiceContext,
  pass: Pick<Pass, 'templateId' | 'orgId' | 'mode'>,
  proof: NonNullable<ConnectionPassContext['retainedReleaseProof']>,
  captured?: PassReleaseSnapshot,
): Promise<PassReleaseSnapshot> {
  let approved: TemplateRelease;
  try {
    approved = await requireApprovedRelease(ctx, pass.templateId, pass.orgId, pass.mode, 'apple');
  } catch (error) {
    if (error instanceof ConflictError && error.code === 'TEMPLATE_RELEASE_REQUIRED')
      throw new ConflictError(
        'The approved release changed. Retry the connection.',
        'TEMPLATE_RELEASE_CONFLICT',
      );
    throw error;
  }
  if (
    approved.provider !== 'apple' ||
    approved.templateId !== pass.templateId ||
    (approved.orgId !== null && approved.orgId !== pass.orgId) ||
    approved.mode !== pass.mode ||
    approved.id !== proof.id ||
    approved.generation !== proof.generation ||
    approved.version !== proof.version ||
    (captured &&
      (approved.orgId !== captured.orgId || approved.candidateHash !== captured.candidateHash))
  )
    throw new ConflictError(
      'The approved release changed. Retry the connection.',
      'TEMPLATE_RELEASE_CONFLICT',
    );
  return {
    id: approved.id,
    generation: approved.generation,
    orgId: approved.orgId,
    candidateHash: approved.candidateHash,
    provider: 'apple',
  };
}

export async function checkedPass(ctx: ServiceContext, context: ConnectionPassContext) {
  if (!validConnectionPassContext(context)) throw stalePass();
  if (
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== context.credentialKeysetCommitment
  )
    throw stalePass();
  const pass = await getPass(ctx.env.DB, context.passId);
  if (!pass) throw stalePass();
  if (
    pass.orgId !== context.orgId ||
    pass.mode !== context.mode ||
    pass.connectionId !== context.connectionId ||
    pass.externalRef !== context.externalRef
  )
    throw new ConflictError(
      'The pass is not linked to this connection.',
      'PASS_CONNECTION_MISMATCH',
    );
  if (
    context.retainedReleaseProof &&
    (pass.releaseId !== context.retainedReleaseProof.id ||
      pass.templateVersion !== context.retainedReleaseProof.version)
  )
    throw stalePass();
  if (!(await matchesConnectionPass(ctx.env.DB, context))) throw stalePass();
  return pass;
}
