import type { z } from 'zod';
import type {
  ClosedOrgSchema,
  OrgExportSchema,
  OrgLifecycleSchema,
} from '../../../shared/contracts/org-lifecycle.ts';
import { ORG_LIFECYCLE_COPY as COPY } from '../../../shared/copy/org-lifecycle.ts';
import { orgClosedEmail, orgReopenedEmail } from '../../email/org-closed.ts';
import type { Actor } from '../../platform/context.ts';
import { baseUrl } from '../../platform/env.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { requirePersonalClose } from '../orgs/personal-guard.ts';
import { readOrgAdminEmails } from '../retention/repo.ts';
import { purgeOrgWalletArt } from '../wallet-providers/projection-art-purge.ts';
import { exportKey, LINK_MS, linkMac } from './export.ts';
import { orgDay } from './org-day.ts';
import {
  actorHolds,
  closedOrgs,
  consumeExportLink,
  type ExportRow,
  exportOrgId,
  exportRow,
  exportRows,
  failExport,
  identityBelongs,
  insertExport,
  isOrgAdmin,
  type LifecycleActor,
  type LifecycleRow,
  lifecycleRow,
  setExportLink,
} from './repo.ts';
import { type CloseBy, closeOrgRow, reopenOrgRow } from './repo-state.ts';

type Lifecycle = z.infer<typeof OrgLifecycleSchema>;
type ExportDto = z.infer<typeof OrgExportSchema>;
type ClosedDto = z.infer<typeof ClosedOrgSchema>;

const notFound = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');

function lifecycleDto(row: LifecycleRow, now: number): Lifecycle {
  const closed = row.status === 'deleted';
  return {
    orgId: row.id,
    status: row.status === 'deleted' ? 'closed' : row.status,
    closedAt: row.closed_at,
    purgeAfter: row.purge_after,
    purging: row.purge_started_at !== null,
    purged: row.purged_at !== null,
    held: row.held === 1,
    canReopen:
      closed &&
      row.closed_at !== null &&
      row.purge_started_at === null &&
      row.purge_after !== null &&
      row.purge_after >= now,
  };
}

/** What a caller may read: a platform admin any org, an org admin her own (any status). */
export async function readLifecycle(
  ctx: ServiceContext,
  orgId: string,
  actor: LifecycleActor,
): Promise<Lifecycle> {
  const row = await lifecycleRow(ctx.env.DB, orgId);
  if (!row) throw notFound();
  await requireCaller(ctx, orgId, actor);
  return lifecycleDto(row, ctx.clock.now());
}

/** A personal organization's holder data goes to its owner only: a platform admin may close or reopen it, not export it. */
async function requireExportAccess(ctx: ServiceContext, orgId: string, actor: LifecycleActor) {
  const org = await lifecycleRow(ctx.env.DB, orgId);
  if (!org || (org.personal_user_id !== null && org.personal_user_id !== actor.userId))
    throw notFound();
}

async function requireCaller(ctx: ServiceContext, orgId: string, actor: LifecycleActor) {
  if (actor.kind === 'owner' && !(await isOrgAdmin(ctx.env.DB, orgId, actor.userId)))
    throw new ForbiddenError();
  if (!(await actorHolds(ctx.env.DB, actor, orgId, ctx.clock.now()))) throw new ForbiddenError();
}

async function mailAdmins(
  ctx: ServiceContext,
  orgId: string,
  message: {
    subject: string;
    html: string;
    text: string;
  },
) {
  const mailer = createEmailBindingMailer(ctx.env);
  for (const to of await readOrgAdminEmails(ctx.env.DB, orgId)) {
    try {
      await mailer.send({ to, ...message });
    } catch {
      // Provider errors can carry message content, so none is logged.
      ctx.log.error('org.lifecycle_notice_failed', { orgId, code: 'ORG_NOTICE_FAILED' });
    }
  }
}

/**
 * Closes the org: read-only, passes stop updating, 30 days to export. A platform admin closes any org but a
 * personal one; an org admin closes her own by typing its slug. A legal hold refuses it. Every org admin is mailed.
 */
export async function closeOrg(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  by: CloseBy,
  confirmSlug?: string,
): Promise<Lifecycle> {
  const before = await lifecycleRow(ctx.env.DB, orgId);
  if (!before || before.purged_at !== null) throw notFound();
  if (by.kind === 'owner') {
    if (by.authority.orgId !== orgId || by.authority.capability !== 'org:manage')
      throw new ForbiddenError();
    if (confirmSlug !== before.slug)
      throw new ValidationError('Invalid request.', [
        { path: 'confirmSlug', message: COPY.slugMismatch },
      ]);
  } else await requirePersonalClose(ctx.env.DB, before, by.userId);
  // A closed org is gone from the directory: closing it again is a 404, as deleting it always was.
  if (before.status === 'deleted') throw notFound();
  if (before.held) throw new ConflictError(COPY.held, 'ORG_HELD');
  if (!(await closeOrgRow(ctx, before, by)))
    throw new ConflictError('The organization changed. Reload and retry.', 'ORG_CONFLICT');
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId,
    action: 'org.close',
    targetType: 'org',
    targetId: orgId,
    detail: { slug: before.slug, name: before.name, by: by.kind },
  });
  await purgeOrgWalletArt(ctx, orgId);
  const after = await lifecycleRow(ctx.env.DB, orgId);
  if (after?.purge_after) {
    const purgeDay = await orgDay(ctx, orgId, after.purge_after);
    const mail = orgClosedEmail(baseUrl(ctx.env), before.name, purgeDay);
    await mailAdmins(ctx, orgId, mail);
  }
  return lifecycleDto(after ?? before, ctx.clock.now());
}

/** Platform admin: a closed org back to active, with its default identity, while the window is open. */
export async function reopenOrg(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  by: { userId: string; sessionId: string },
): Promise<Lifecycle> {
  const before = await lifecycleRow(ctx.env.DB, orgId);
  if (before?.status !== 'deleted' || before.closed_at === null) throw notFound();
  if (before.purge_started_at !== null || before.purged_at !== null)
    throw new ConflictError(COPY.purging, 'ORG_PURGING');
  if (before.purge_after === null || before.purge_after < ctx.clock.now())
    throw new ConflictError(COPY.windowOver, 'ORG_REOPEN_WINDOW');
  const identity =
    before.closed_identity_id &&
    (await identityBelongs(ctx.env.DB, orgId, before.closed_identity_id))
      ? before.closed_identity_id
      : null;
  if (!(await reopenOrgRow(ctx, before, by, identity)))
    throw new ConflictError('The organization changed. Reload and retry.', 'ORG_CONFLICT');
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId,
    action: 'org.reopen',
    targetType: 'org',
    targetId: orgId,
  });
  await mailAdmins(ctx, orgId, orgReopenedEmail(baseUrl(ctx.env), before.name));
  const after = await lifecycleRow(ctx.env.DB, orgId);
  return lifecycleDto(after ?? before, ctx.clock.now());
}

export async function listClosed(ctx: ServiceContext): Promise<ClosedDto[]> {
  return (await closedOrgs(ctx.env.DB, 200)).map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    closedAt: r.closed_at ?? 0,
    purgeAfter: r.purge_after ?? 0,
    purging: r.purge_started_at !== null,
    held: r.held === 1,
  }));
}

function exportDto(row: ExportRow): ExportDto {
  return {
    id: row.id,
    state: row.state,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
    bytes: row.bytes,
    entities: row.entities ? (JSON.parse(row.entities) as Record<string, number>) : null,
    errorCode: row.error_code,
  };
}

export async function listExports(
  ctx: ServiceContext,
  orgId: string,
  actor: LifecycleActor,
): Promise<ExportDto[]> {
  await requireExportAccess(ctx, orgId, actor);
  await requireCaller(ctx, orgId, actor);
  return (await exportRows(ctx.env.DB, orgId)).map(exportDto);
}

/**
 * Starts an archive of everything the org holds. One at a time per org; the row lands only while the caller's
 * session and role still hold. The workflow runs under the export's id, so a repeat start is a no-op.
 */
export async function requestExport(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  by: LifecycleActor,
): Promise<ExportDto> {
  const org = await lifecycleRow(ctx.env.DB, orgId);
  if (!org || org.purged_at !== null) throw notFound();
  await requireExportAccess(ctx, orgId, by);
  if (by.kind === 'owner' && !(await isOrgAdmin(ctx.env.DB, orgId, by.userId)))
    throw new ForbiddenError();
  if (org.purge_started_at !== null) throw new ConflictError(COPY.purging, 'ORG_PURGING');
  const id = ctx.ids.id();
  if (!(await insertExport(ctx.env.DB, { id, orgId, now: ctx.clock.now() }, by))) {
    const open = (await exportRows(ctx.env.DB, orgId)).some(
      (e) => e.state === 'queued' || e.state === 'running',
    );
    if (open) throw new ConflictError('An export is already running.', 'ORG_EXPORT_RUNNING');
    throw new ForbiddenError();
  }
  try {
    await ctx.env.ORG_EXPORT.create({ id, params: { orgId, exportId: id } });
  } catch (error) {
    ctx.log.error('org.export_start_failed', { orgId, code: 'ORG_EXPORT_START', error });
    await failExport(ctx.env.DB, id, 'ORG_EXPORT_START', ctx.clock.now());
  }
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId,
    action: 'org.export',
    targetType: 'org',
    targetId: orgId,
    detail: { exportId: id, by: by.kind },
  });
  const row = await exportRow(ctx.env.DB, orgId, id);
  if (!row) throw notFound();
  return exportDto(row);
}

/** A download link for a ready archive, good for 1 hour and one download. Anyone holding it can download, so it is audited. */
export async function exportLink(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  exportId: string,
  by: LifecycleActor,
): Promise<{ url: string; expiresAt: number }> {
  await requireExportAccess(ctx, orgId, by);
  await requireCaller(ctx, orgId, by);
  const row = await exportRow(ctx.env.DB, orgId, exportId);
  if (row?.state !== 'ready') throw new NotFoundError('Export not found.', 'EXPORT_NOT_FOUND');
  const expiresAt = ctx.clock.now() + LINK_MS;
  const sig = await linkMac(ctx.env, orgId, exportId, expiresAt);
  await setExportLink(ctx.env.DB, exportId, expiresAt);
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId,
    action: 'org.export_link',
    targetType: 'org',
    targetId: orgId,
    detail: { exportId },
  });
  return {
    url: `${baseUrl(ctx.env)}/api/v1/org-exports/${exportId}/download?exp=${expiresAt}&sig=${sig}`,
    expiresAt,
  };
}

/** The archive behind a valid link: the MAC covers the org, the export and the expiry. */
export async function openExport(
  ctx: ServiceContext,
  exportId: string,
  exp: number,
  sig: string,
): Promise<{ body: ReadableStream; name: string; size: number }> {
  const gone = new NotFoundError('Export not found.', 'EXPORT_NOT_FOUND');
  const orgId = await exportOrgId(ctx.env.DB, exportId);
  if (!orgId || exp < ctx.clock.now()) throw gone;
  if (!(await safeEqual(sig, await linkMac(ctx.env, orgId, exportId, exp)))) throw gone;
  const export_ = await exportRow(ctx.env.DB, orgId, exportId);
  const org = await lifecycleRow(ctx.env.DB, orgId);
  if (export_?.state !== 'ready' || !org || org.purge_started_at !== null) throw gone;
  if (!(await consumeExportLink(ctx.env.DB, exportId, exp, ctx.clock.now()))) throw gone;
  const object = await ctx.env.BUCKET.get(exportKey(orgId, exportId));
  if (!object) throw gone;
  return {
    body: object.body,
    size: object.size,
    name: `${org.slug}-export-${await orgDay(ctx, orgId, export_.created_at)}.zip`,
  };
}
