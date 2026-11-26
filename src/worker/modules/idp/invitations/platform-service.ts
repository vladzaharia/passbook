import type {
  CreatePlatformInvitation,
  PlatformInvitation,
  PlatformInvitationCreated,
} from '../../../../shared/contracts/platform-invitations.ts';
import { INVITE_PATH, INVITE_PREFIX } from '../../../../shared/invitation-link.ts';
import { baseUrl } from '../../../platform/env.ts';
import {
  ConflictError,
  NotFoundError,
  UnavailableError,
  ValidationError,
} from '../../../platform/errors.ts';
import { sha256Hex } from '../../../platform/ids.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { recordAudit } from '../../audit/service.ts';
import { createEmailBindingMailer } from '../../delivery/mailer.ts';
import { idpReady } from '../../dev-access/availability.ts';
import { userName } from '../../orgs/repo-members.ts';
import { idpClient, idpConfigured } from '../client.ts';
import { platformInvitationEmail } from './platform-email.ts';
import { platformInviteOf } from './platform-resolve.ts';
import {
  groupNames,
  insertPlatform,
  listPlatform,
  openPlatformFor,
  type PlatformRow,
  platformById,
  revokePlatform,
} from './repo-platform.ts';
import { withdrawSetups } from './withdraw.ts';

const DAY = 24 * 60 * 60 * 1000;
const TTL = 7 * DAY;
const LISTED_FOR = 30 * DAY;
const LIST_LIMIT = 200;

function dto(row: PlatformRow, now: number): PlatformInvitation {
  const invite = platformInviteOf(row, now);
  return {
    id: row.id,
    email: row.email,
    groups: invite?.groups ?? [],
    developer: row.developer === 1,
    state: invite?.state ?? 'revoked',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

/** Polaris ID changes are refused in dry run, and unless it is reachable, healthy and has the groups sign-in reads. */
async function assertLive(ctx: ServiceContext, developer: boolean): Promise<void> {
  if (await idpReady(ctx, developer ? ['developer'] : [])) return;
  const dry =
    idpConfigured(ctx.env) &&
    (await idpClient(ctx.env, ctx.log)
      .health()
      .then((h) => h.mode === 'dry_run')
      .catch(() => false));
  throw dry
    ? new ConflictError('Polaris ID changes are in dry run.', 'IDP_DRY_RUN')
    : new UnavailableError(
        'Polaris ID is not reachable. Try again in a few minutes.',
        'IDP_UNAVAILABLE',
      );
}

export async function listPlatformInvitations(
  ctx: ServiceContext,
): Promise<{ items: PlatformInvitation[]; nextCursor: null }> {
  const now = ctx.clock.now();
  const rows = await listPlatform(ctx.env.DB, now - LISTED_FOR, LIST_LIMIT);
  return { items: rows.map((row) => dto(row, now)), nextCursor: null };
}

interface Issued {
  email: string;
  groups: readonly string[];
  developer: boolean;
}

/** Writes the row and mails the link; a failed mail revokes the row. The link comes back once. */
async function issue(
  ctx: ServiceContext,
  actorId: string,
  op: 'create' | 'resend',
  input: Issued,
): Promise<PlatformInvitationCreated> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const secret = `${INVITE_PREFIX.platform}${ctx.ids.token(32)}`;
  const id = ctx.ids.id();
  await insertPlatform(
    ctx,
    {
      id,
      email: input.email,
      hash: await sha256Hex(secret),
      groups: input.groups,
      developer: input.developer,
      createdByUser: actorId,
      createdByKey: null,
      now,
      expires: now + TTL,
      claimUntil: now + TTL + DAY,
    },
    {
      actorType: 'user',
      actorId,
      action: 'idp.invite_platform',
      targetType: 'platform_invitation',
      targetId: id,
      detail: { op, groups: input.groups.length, developer: input.developer },
    },
  );
  const link = `${baseUrl(ctx.env)}${INVITE_PATH}#${secret}`;
  try {
    await createEmailBindingMailer(ctx.env).send({
      to: input.email,
      ...platformInvitationEmail({
        link,
        base: baseUrl(ctx.env),
        developer: input.developer,
        inviter: await userName(db, actorId),
      }),
    });
  } catch {
    // Provider errors can contain message content, including the secret link, so none is logged.
    ctx.log.error('platform_invitation.send_failed', { code: 'PLATFORM_INVITE_SEND_FAILED' });
    await revokePlatform(db, id, ctx.clock.now());
    throw new UnavailableError('Unable to deliver the invitation.');
  }
  const row = await platformById(db, id);
  if (!row) throw new NotFoundError();
  return { ...dto(row, now), link };
}

export async function createPlatformInvitation(
  ctx: ServiceContext,
  actorId: string,
  input: CreatePlatformInvitation,
): Promise<PlatformInvitationCreated> {
  await assertLive(ctx, input.developer);
  const known = await groupNames(ctx.env.DB, input.groups);
  const missing = input.groups.find((key) => !known.has(key));
  if (missing !== undefined)
    throw new ValidationError('That group does not exist.', [
      { path: 'groups', message: 'That group does not exist.' },
    ]);
  if (await openPlatformFor(ctx.env.DB, input.email, ctx.clock.now()))
    throw new ConflictError(
      'This address already has a pending invitation. Revoke it to send a new one.',
      'PLATFORM_INVITE_PENDING',
    );
  return issue(ctx, actorId, 'create', input);
}

/** A new secret on a new row; the old row is revoked (rows are immutable). Pending and expired invitations only. */
export async function resendPlatformInvitation(
  ctx: ServiceContext,
  actorId: string,
  id: string,
): Promise<PlatformInvitationCreated> {
  const old = await platformById(ctx.env.DB, id);
  if (!old) throw new NotFoundError();
  const invite = platformInviteOf(old, ctx.clock.now());
  if (!invite || invite.state === 'accepted' || invite.state === 'revoked')
    throw new ConflictError('This invitation has ended.', 'PLATFORM_INVITE_CONFLICT');
  await assertLive(ctx, invite.developer);
  // The old row goes first, so the pending-address check does not meet it; the new row follows at once.
  if (!(await revokePlatform(ctx.env.DB, id, ctx.clock.now())))
    throw new ConflictError('This invitation has ended.', 'PLATFORM_INVITE_CONFLICT');
  await withdrawSetups(ctx, 'platform', id);
  return issue(ctx, actorId, 'resend', {
    email: old.email,
    groups: invite.groups,
    developer: invite.developer,
  });
}

export async function revokePlatformInvitation(
  ctx: ServiceContext,
  actorId: string,
  id: string,
): Promise<void> {
  const row = await platformById(ctx.env.DB, id);
  if (!row) throw new NotFoundError();
  if (!(await revokePlatform(ctx.env.DB, id, ctx.clock.now())))
    throw new ConflictError('This invitation has ended.', 'PLATFORM_INVITE_CONFLICT');
  await recordAudit(ctx, {
    actorType: 'user',
    actorId,
    action: 'idp.invite_platform',
    targetType: 'platform_invitation',
    targetId: id,
    detail: { op: 'revoke' },
  });
  await withdrawSetups(ctx, 'platform', id);
}
