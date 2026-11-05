import type { z } from 'zod';
import {
  BUNDLE_MAX_PASSES,
  type BundleListSchema,
  type BundleSchema,
  type CreateBundleSchema,
} from '../../../shared/contracts/bundles.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { batch } from '../../platform/db.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { recordAudit } from '../audit/service.ts';
import { getPass } from '../passes/repo.ts';
import { assertWritableMode, type ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import { enqueueBundleEmail } from './email-queue.ts';
import * as repo from './repo.ts';

export type BundleDto = z.infer<typeof BundleSchema>;
type BundlePage = z.infer<typeof BundleListSchema>;

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
): Promise<repo.BundleRow> {
  const row = await repo.getBundle(ctx.env.DB, id, orgScope);
  if (!row) throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
  return row;
}

/** For changes: a bundle of the other mode fails like a pass does (404 for keys, 409 for sessions). */
async function requireBundleForWrite(
  ctx: ServiceContext,
  id: string,
  orgScope: ScopeArg,
): Promise<repo.BundleRow> {
  const row = await requireBundle(ctx, id, orgScope);
  assertWritableMode(orgScope, row.mode, 'bundle');
  return row;
}

/** Every pass must be in the org and in the caller's mode, or the bundle is refused. */
async function checkPasses(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  passIds: string[],
): Promise<void> {
  if (new Set(passIds).size !== passIds.length)
    throw new ValidationError('A pass is listed twice.', [], 'BUNDLE_DUPLICATE_PASS');
  if (passIds.length > BUNDLE_MAX_PASSES)
    throw new ValidationError('A bundle holds at most 10 passes.', [], 'BUNDLE_TOO_MANY');
  const passes = await Promise.all(passIds.map((id) => getPass(ctx.env.DB, id, orgId)));
  if (passes.some((p) => !p)) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (passes.some((p) => p?.mode !== mode))
    throw new ValidationError(
      `A ${mode} bundle holds ${mode} passes only.`,
      [],
      'BUNDLE_MODE_MISMATCH',
    );
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
): Promise<BundleDto> {
  const holderEmail = input.holderEmail ? strictEmail(input.holderEmail) : null;
  if (input.holderEmail && !holderEmail)
    throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (input.sendEmail && !holderEmail)
    throw new ValidationError('Add an email to send the bundle.', [], 'NO_RECIPIENT');
  await checkPasses(ctx, input.orgId, mode, input.passIds);
  const row = {
    id: ctx.ids.id(),
    orgId: input.orgId,
    mode,
    name: input.name,
    token: ctx.ids.token(),
    holderEmail,
    actor: { type: actor.type, id: actor.id },
    passIds: input.passIds,
    now: ctx.clock.now(),
  };
  await batch(ctx.env.DB, [
    ...repo.insertBundleStmts(ctx.env.DB, row),
    auditStmt(ctx.env.DB, ctx, {
      orgId: input.orgId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'bundle.create',
      targetType: 'bundle',
      targetId: row.id,
      detail: { passes: input.passIds.length, mode },
    }),
  ]);
  if (input.sendEmail && holderEmail) {
    try {
      await enqueueBundleEmail(ctx, row.id, holderEmail);
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
): Promise<BundleDto> {
  const [dto] = await withMembers(ctx, [await requireBundle(ctx, id, orgScope)]);
  if (!dto) throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
  return dto;
}

/** Lists the caller's mode only; `orgScope` pins an org-scoped API key to its org. */
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
): Promise<BundleDto> {
  const row = await requireBundleForWrite(ctx, id, orgScope);
  await batch(ctx.env.DB, [
    repo.setBundleTokenStmt(ctx.env.DB, id, ctx.ids.token(), ctx.clock.now()),
    auditStmt(ctx.env.DB, ctx, {
      orgId: row.org_id,
      actorType: actor.type,
      actorId: actor.id,
      action: 'bundle.rotate_link',
      targetType: 'bundle',
      targetId: id,
    }),
  ]);
  return getBundleDto(ctx, id, orgScope);
}

export async function deleteBundle(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  orgScope: ScopeArg,
): Promise<void> {
  const row = await requireBundleForWrite(ctx, id, orgScope);
  await batch(ctx.env.DB, [
    repo.deleteBundleStmt(ctx.env.DB, id),
    auditStmt(ctx.env.DB, ctx, {
      orgId: row.org_id,
      actorType: actor.type,
      actorId: actor.id,
      action: 'bundle.delete',
      targetType: 'bundle',
      targetId: id,
    }),
  ]);
}

export async function sendBundleEmail(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: { to?: string | undefined },
  orgScope: ScopeArg,
): Promise<void> {
  const row = await requireBundleForWrite(ctx, id, orgScope);
  const to = input.to ?? row.holder_email;
  if (!to) throw new ValidationError('The bundle has no email.', [], 'NO_RECIPIENT');
  // API keys may not turn this into a mail relay.
  if (actor.type !== 'user' && to.toLowerCase() !== row.holder_email?.toLowerCase())
    throw new ValidationError('Only the bundle email can be used.', [], 'RECIPIENT_NOT_HOLDER');
  await enqueueBundleEmail(ctx, id, to);
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'bundle.send_email',
    targetType: 'bundle',
    targetId: id,
  });
}
