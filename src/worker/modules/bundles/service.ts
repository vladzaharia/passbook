import type { z } from 'zod';
import type {
  BundleListSchema,
  BundleSchema,
  CreateBundleSchema,
} from '../../../shared/contracts/bundles.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { Grant } from '../../platform/authority.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sendOnce } from '../delivery/idempotent-send.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { assertWritableMode, type ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import { enqueueBundleEmail } from './email-queue.ts';
import * as repo from './repo.ts';
import { bundleMutationGrant, createBundleGrant } from './repo-writes.ts';
import { checkPasses } from './service-pass-validation.ts';

export type BundleDto = z.infer<typeof BundleSchema>;
type BundlePage = z.infer<typeof BundleListSchema>;

/** System execution is reserved for trusted workflows and fixtures; HTTP supplies its principal. */
export type BundleWriteExecution = { kind: 'system' } | { kind: 'tenant'; auth: AuthContext };

function executionAuth(execution: BundleWriteExecution): AuthContext | undefined {
  if (execution?.kind === 'system') return undefined;
  if (execution?.kind === 'tenant' && execution.auth) return execution.auth;
  throw new ForbiddenError();
}

export const bundleUrl = (ctx: ServiceContext, token: string) => `${baseUrl(ctx.env)}/b/${token}`;

function toDto(ctx: ServiceContext, row: repo.BundleRow, members: repo.MemberRow[]): BundleDto {
  return {
    id: row.id,
    orgId: row.org_id,
    mode: row.mode,
    name: row.name,
    url: bundleUrl(ctx, row.token),
    holderEmail: row.holder_email,
    passes: members.map((m) => ({
      id: m.pass_id,
      title: m.title,
      status: m.status,
      removedAt: m.removed_at,
    })),
    createdAt: row.created_at,
    linkRotatedAt: row.token_rotated_at,
  };
}

async function withMembers(ctx: ServiceContext, rows: repo.BundleRow[]): Promise<BundleDto[]> {
  const members = await repo.membersOf(
    ctx.env.DB,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    toDto(
      ctx,
      row,
      members.filter((m) => m.bundle_id === row.id),
    ),
  );
}

async function requireBundle(
  ctx: ServiceContext,
  id: string,
  orgScope: ScopeArg,
  auth?: AuthContext,
  capability: 'passes:read' | 'passes:operate' = 'passes:read',
): Promise<{ row: repo.BundleRow; authority?: TenantPassWrite }> {
  const row = await repo.getBundle(ctx.env.DB, id, orgScope);
  if (!row) throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
  if (!auth) return { row };
  try {
    return { row, authority: await tenantAuthorityOf(ctx, auth, row.org_id, capability) };
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    if (capability === 'passes:operate') {
      try {
        await tenantAuthorityOf(ctx, auth, row.org_id, 'passes:read');
      } catch (readError) {
        if (readError instanceof ForbiddenError)
          throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
        throw readError;
      }
      throw error;
    }
    throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
  }
}

/** A lost lineage on a mutation reads as a missing bundle, as it did before grants. */
async function commitBundleMutation(g: Grant): Promise<void> {
  try {
    await g.commit();
  } catch (error) {
    if (error instanceof AppError && error.code === 'BUNDLE_NOT_FOUND')
      throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
    throw error;
  }
}

/**
 * `holderEmail` with `sendEmail` relays the link to any address the caller names, so it counts
 * against the same per-recipient and per-org email caps as pass emails.
 */
export async function createBundle(
  ctx: ServiceContext,
  actor: Actor,
  mode: Mode,
  input: z.infer<typeof CreateBundleSchema>,
  execution: BundleWriteExecution,
): Promise<BundleDto> {
  const auth = executionAuth(execution);
  const authority = auth
    ? await tenantAuthorityOf(ctx, auth, input.orgId, 'passes:operate')
    : undefined;
  const holderEmail = input.holderEmail ? strictEmail(input.holderEmail) : null;
  if (input.holderEmail && !holderEmail)
    throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (input.sendEmail && !holderEmail)
    throw new ValidationError('Add an email to send the bundle.', [], 'NO_RECIPIENT');
  const passes = await checkPasses(ctx, input.orgId, mode, input.passIds);
  const row = {
    id: ctx.ids.id(),
    orgId: input.orgId,
    mode,
    name: input.name,
    token: ctx.ids.token(),
    holderEmail,
    actor: { type: actor.type, id: actor.id },
    passes,
    now: ctx.clock.now(),
  };
  await createBundleGrant(ctx, row, authority, { passes: input.passIds.length, mode }).commit();
  if (input.sendEmail && holderEmail) {
    try {
      await enqueueBundleEmail(
        ctx,
        row.id,
        holderEmail,
        { token: row.token, holderEmail },
        authority,
      );
    } catch (error) {
      // The bundle exists and a retry would create a second live link: a failed email is resent
      // on request, never a failed create.
      const code = error instanceof AppError ? error.code : 'BUNDLE_EMAIL_ENQUEUE';
      ctx.log.warn('bundles.email_not_queued', {
        code,
        orgId: input.orgId,
        bundleId: row.id,
        ...(code === 'BUNDLE_EMAIL_ENQUEUE' ? { error } : {}),
      });
    }
  }
  return getBundleDto(ctx, row.id, input.orgId);
}

export async function getBundleDto(
  ctx: ServiceContext,
  id: string,
  orgScope: ScopeArg,
  auth?: AuthContext,
): Promise<BundleDto> {
  const { row } = await requireBundle(ctx, id, orgScope, auth);
  const [dto] = await withMembers(ctx, [row]);
  if (!dto) throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
  return dto;
}

/** Lists one authorized organization's bundles in the caller's mode. */
export async function listBundles(
  ctx: ServiceContext,
  filter: Omit<repo.BundleListFilter, 'limit'> & { limit: number },
): Promise<BundlePage> {
  const rows = await repo.listBundleRows(ctx.env.DB, { ...filter, limit: filter.limit + 1 });
  const page = rows.slice(0, filter.limit);
  return {
    items: await withMembers(ctx, page),
    nextCursor: rows.length > filter.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function rotateBundleLink(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  orgScope: ScopeArg,
  execution: BundleWriteExecution,
): Promise<BundleDto> {
  const { row, authority } = await requireBundle(
    ctx,
    id,
    orgScope,
    executionAuth(execution),
    'passes:operate',
  );
  assertWritableMode(orgScope, row.mode, 'bundle');
  await commitBundleMutation(
    bundleMutationGrant(ctx, {
      id,
      orgId: row.org_id,
      mode: row.mode,
      authority,
      actor,
      action: 'rotate_link',
      token: ctx.ids.token(),
    }),
  );
  return getBundleDto(ctx, id, orgScope);
}

export async function deleteBundle(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  orgScope: ScopeArg,
  execution: BundleWriteExecution,
): Promise<void> {
  const { row, authority } = await requireBundle(
    ctx,
    id,
    orgScope,
    executionAuth(execution),
    'passes:operate',
  );
  assertWritableMode(orgScope, row.mode, 'bundle');
  await commitBundleMutation(
    bundleMutationGrant(ctx, {
      id,
      orgId: row.org_id,
      mode: row.mode,
      authority,
      actor,
      action: 'delete',
    }),
  );
}

export async function sendBundleEmail(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: { to?: string | undefined },
  orgScope: ScopeArg,
  execution: BundleWriteExecution,
  idempotencyKey?: string,
): Promise<void> {
  const { row, authority } = await requireBundle(
    ctx,
    id,
    orgScope,
    executionAuth(execution),
    'passes:operate',
  );
  assertWritableMode(orgScope, row.mode, 'bundle');
  const to = input.to ?? row.holder_email;
  if (!to) throw new ValidationError('The bundle has no email.', [], 'NO_RECIPIENT');
  // API keys may not turn this into a mail relay.
  if (actor.type !== 'user' && to.toLowerCase() !== row.holder_email?.toLowerCase())
    throw new ValidationError('Only the bundle email can be used.', [], 'RECIPIENT_NOT_HOLDER');
  const send = () =>
    enqueueBundleEmail(
      ctx,
      id,
      to,
      { token: row.token, holderEmail: row.holder_email },
      authority,
      actor,
    );
  if (idempotencyKey === undefined || !authority) {
    await send();
    return;
  }
  await sendOnce(
    ctx,
    {
      orgId: row.org_id,
      scope: `bundle-send:${id}`,
      key: idempotencyKey,
      request: [id, input.to?.toLowerCase() ?? null],
      authority,
    },
    async () => {
      await send();
      return { ok: true as const };
    },
  );
}
