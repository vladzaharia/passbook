import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TemplateRelease } from '../templates/releases.ts';
import { assertTenantCreateAuthority } from './create-authority.ts';
import { scheduleRequiredIssuanceDelivery } from './create-delivery.ts';
import { captureIssuanceKeyset } from './create-keyset.ts';
import { resolveCreateRelease, validateCreateReview } from './create-release.ts';
import { createPassRowWithRelease } from './create-row.ts';
import type { CreateParams } from './create-types.ts';
import { assertPassDetailReadable, detailOf } from './detail.ts';
import {
  claimIdempotencyKey,
  getIdempotencyKey,
  type IdempotencyRow,
  type Pass,
  releaseIdempotencyKey,
} from './repo.ts';
import { getOrg } from './repo-read-issuance.ts';
import { getPass } from './repo-read-pass.ts';

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Keep every credential reference on the same key material as the captured keyset. */
function snapshotCredentialContext(ctx: ServiceContext): ServiceContext {
  return { ...ctx, env: { ...ctx.env } };
}

/** Builds, stores and inserts a pass; the `pass_created` trigger records version 1. */
export async function createPassRow(ctx: ServiceContext, input: CreateParams): Promise<Pass> {
  return createPassFromSnapshot(ctx, structuredClone(input), snapshotCredentialContext(ctx));
}

async function createPassFromSnapshot(
  ctx: ServiceContext,
  p: CreateParams,
  credentialCtx: ServiceContext,
): Promise<Pass> {
  await assertTenantCreateAuthority(ctx, p);
  const keysetCommitment = await captureIssuanceKeyset(credentialCtx, p);
  const release = await resolveCreateRelease(ctx, p);
  return createPassRowWithRelease(ctx, p, release, keysetCommitment, credentialCtx.env);
}

async function issuanceDetail(ctx: ServiceContext, p: CreateParams, pass: Pass) {
  const tenant = p.execution.kind === 'tenant' ? p.execution : undefined;
  const detail = await detailOf(ctx, pass, tenant?.authority, tenant?.additionalAuthority);
  await assertPassDetailReadable(
    ctx,
    pass,
    tenant?.authority,
    detail.reissueRequired,
    tenant?.additionalAuthority,
  );
  return detail;
}

async function replayIdempotentPass(
  ctx: ServiceContext,
  p: CreateParams,
  hash: string,
  existing: IdempotencyRow | null,
) {
  await assertTenantCreateAuthority(ctx, p);
  if (!existing || existing.requestHash !== hash)
    throw new ConflictError(
      'The Idempotency-Key was used with a different request.',
      'IDEMPOTENCY_KEY_REUSED',
    );
  let pass = existing.resourceId ? await getPass(ctx.env.DB, existing.resourceId, p.orgId) : null;
  if (!pass || pass.mode !== p.mode)
    throw new ConflictError(
      'The original request is still running. Retry shortly.',
      'IDEMPOTENCY_IN_PROGRESS',
    );
  await assertTenantCreateAuthority(ctx, p);
  if (p.sendEmail && p.holderEmail) {
    await scheduleRequiredIssuanceDelivery(ctx, pass.id);
    pass = await getPass(ctx.env.DB, pass.id, p.orgId);
    if (!pass || pass.mode !== p.mode)
      throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
  }
  const tenant = p.execution.kind === 'tenant' ? p.execution : undefined;
  const detail = await detailOf(ctx, pass, tenant?.authority, tenant?.additionalAuthority);
  await assertTenantCreateAuthority(ctx, p);
  const org = await getOrg(ctx.env.DB, p.orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  await assertPassDetailReadable(
    ctx,
    pass,
    tenant?.authority,
    detail.reissueRequired,
    tenant?.additionalAuthority,
  );
  return detail;
}

/**
 * Admin/API create. With an Idempotency-Key a retry returns the original pass; the same key with a
 * different body is rejected. `serverResolvedRelease` marks a release the server picked for a caller
 * that pinned none: it is not part of the request, so a retry after an approval hashes the same.
 */
export async function createPassIdempotent(
  ctx: ServiceContext,
  input: CreateParams,
  key: string | undefined,
  options: { serverResolvedRelease?: boolean } = {},
) {
  const p = structuredClone(input);
  const credentialCtx = snapshotCredentialContext(ctx);
  if (!key) return issuanceDetail(ctx, p, await createPassFromSnapshot(ctx, p, credentialCtx));
  if (p.reservedPassId !== undefined)
    throw new ConflictError(
      'Retained connection items cannot use an idempotency key.',
      'PASS_CONFLICT',
    );
  const db = ctx.env.DB;
  await assertTenantCreateAuthority(ctx, p);
  const keysetCommitment = await captureIssuanceKeyset(credentialCtx, p);
  validateCreateReview(p);
  const org = await getOrg(db, p.orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const hash = await sha256Hex(
    stableStringify({
      ...p,
      actor: undefined,
      execution: undefined,
      ...(options.serverResolvedRelease
        ? { templateVersion: undefined, releaseId: undefined, releaseGeneration: undefined }
        : {}),
    }),
  );
  await assertTenantCreateAuthority(ctx, p);
  const existing = await getIdempotencyKey(db, p.orgId, key);
  if (existing) return replayIdempotentPass(ctx, p, hash, existing);
  let release: TemplateRelease;
  try {
    release = await resolveCreateRelease(ctx, p);
  } catch (error) {
    // Another request may have committed this key while the release was being resolved.
    await assertTenantCreateAuthority(ctx, p);
    const raced = await getIdempotencyKey(db, p.orgId, key);
    if (raced) return replayIdempotentPass(ctx, p, hash, raced);
    throw error;
  }
  const passId = ctx.ids.id();
  const tenant = p.execution.kind === 'tenant' ? p.execution : undefined;
  const claimed = await claimIdempotencyKey(
    db,
    p.orgId,
    key,
    hash,
    passId,
    ctx.clock.now(),
    tenant?.authority,
    tenant?.additionalAuthority,
  );
  if (!claimed) {
    await assertTenantCreateAuthority(ctx, p);
    return replayIdempotentPass(ctx, p, hash, await getIdempotencyKey(db, p.orgId, key));
  }
  try {
    return issuanceDetail(
      ctx,
      p,
      await createPassRowWithRelease(
        ctx,
        { ...p, passId },
        release,
        keysetCommitment,
        credentialCtx.env,
      ),
    );
  } catch (error) {
    // Release only our unchanged reservation, and only if no raw pass row was committed.
    await releaseIdempotencyKey(db, p.orgId, key, passId, hash);
    throw error;
  }
}
