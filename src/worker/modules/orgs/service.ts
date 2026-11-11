import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  CreateOrgSchema,
  OrgBrandingSchema,
  OrgDto,
  OrgSummarySchema,
  UpdateOrgSchema,
} from '../../../shared/contracts/orgs.ts';
import type { Actor } from '../../platform/context.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, diffFields, recordAudit } from '../audit/service.ts';
import { markPassesStale } from './branding-stale.ts';
import {
  COUNT_CAP,
  countsFor,
  getOrgRow,
  identityUsableBy,
  insertOrg,
  listOrgRows,
  markOrgDeleted,
  type OrgRow,
  setOrgStatus as setOrgStatusRow,
  slugTaken,
} from './repo.ts';
import {
  insertOrgAsAdmin,
  moveOrgStatusAsAdmin,
  type OrgAdmin,
  type OrgWriteAuthority,
  updateOrgRow,
} from './repo-org-writes.ts';

type Branding = z.infer<typeof OrgBrandingSchema>;
type Summary = z.infer<typeof OrgSummarySchema>;

export function toDto(row: OrgRow): OrgDto {
  const { logo, icon, ...branding } = JSON.parse(row.branding) as Branding;
  const image = (value: NonNullable<Branding['logo']>) => ({
    sha: value.sha,
    w: value.w,
    h: value.h,
  });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    defaultIdentityId: row.default_identity_id,
    branding: {
      ...branding,
      ...(logo ? { logo: image(logo) } : {}),
      ...(icon ? { icon: image(icon) } : {}),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    configRevision: row.config_revision,
  };
}

/** Adds the count of live passes a save will rebuild; absent when none. */
export const withUpdates = (dto: OrgDto, passes: number | undefined): OrgDto =>
  passes === undefined ? dto : { ...dto, passesToUpdate: passes };

export async function requireOrg(ctx: ServiceContext, id: string): Promise<OrgRow> {
  const row = await getOrgRow(ctx.env.DB, id);
  if (!row) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  return row;
}

async function checkIdentity(ctx: ServiceContext, orgId: string | null, identityId: string | null) {
  if (identityId && !(await identityUsableBy(ctx.env.DB, identityId, orgId)))
    throw new ValidationError(
      'Default identity not found for this organization.',
      [{ path: 'defaultIdentityId', message: 'Unknown identity.' }],
      'IDENTITY_NOT_FOUND',
    );
}

async function checkSlug(ctx: ServiceContext, slug: string, exceptId?: string) {
  if (await slugTaken(ctx.env.DB, slug, exceptId))
    throw new ConflictError('That slug is taken.', 'ORG_SLUG_TAKEN');
}

export async function listOrgs(
  ctx: ServiceContext,
  query: { cursor?: string; limit: number; q?: string },
  mode: Mode = 'live',
): Promise<{ items: Summary[]; nextCursor: string | null }> {
  const rows = await listOrgRows(ctx.env.DB, query.cursor, query.limit + 1, query.q);
  const page = rows.slice(0, query.limit);
  const counts = await countsFor(
    ctx.env.DB,
    page.map((r) => r.id),
    mode,
  );
  return {
    items: page.map((row) => summarize(row, counts.get(row.id))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

function summarize(row: OrgRow, counts?: Summary['counts']): Summary {
  const c = counts ?? { passes: 0, templates: 0, connections: 0, apiKeys: 0 };
  return { ...toDto(row), counts: c, countsCapped: Object.values(c).some((n) => n >= COUNT_CAP) };
}

export async function getOrg(
  ctx: ServiceContext,
  id: string,
  mode: Mode = 'live',
): Promise<Summary> {
  const row = await requireOrg(ctx, id);
  return summarize(row, (await countsFor(ctx.env.DB, [id], mode)).get(id));
}

export async function createOrg(
  ctx: ServiceContext,
  actor: Actor,
  input: z.infer<typeof CreateOrgSchema>,
  admin?: OrgAdmin,
): Promise<OrgDto> {
  await checkSlug(ctx, input.slug);
  await checkIdentity(ctx, null, input.defaultIdentityId ?? null);
  const now = ctx.clock.now();
  const row: OrgRow = {
    id: ctx.ids.id(),
    slug: input.slug,
    name: input.name,
    status: 'active',
    default_identity_id: input.defaultIdentityId ?? null,
    branding: JSON.stringify(input.branding ?? {}),
    created_at: now,
    updated_at: now,
    config_revision: 1,
  };
  if (admin) await insertOrgAsAdmin(ctx, row, admin);
  else await insertOrg(ctx.env.DB, row);
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: row.id,
    action: 'org.create',
    targetType: 'org',
    targetId: row.id,
    detail: { slug: row.slug, name: row.name },
  });
  return toDto(row);
}

export async function updateOrg(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: z.infer<typeof UpdateOrgSchema>,
  authority?: OrgWriteAuthority,
): Promise<OrgDto> {
  const before = await requireOrg(ctx, id);
  if (input.slug !== undefined && input.slug !== before.slug) await checkSlug(ctx, input.slug, id);
  if (input.defaultIdentityId !== undefined) await checkIdentity(ctx, id, input.defaultIdentityId);
  const next: OrgRow = {
    ...before,
    slug: input.slug ?? before.slug,
    name: input.name ?? before.name,
    status: input.status ?? before.status,
    default_identity_id:
      input.defaultIdentityId === undefined ? before.default_identity_id : input.defaultIdentityId,
    branding: input.branding ? keepImages(input.branding, before.branding) : before.branding,
    updated_at: ctx.clock.now(),
    config_revision: input.configRevision ?? before.config_revision,
  };
  const saved = await updateOrgRow(ctx, next, authority);
  if (!saved) throw new ForbiddenError();
  const passesToUpdate = await markPassesStale(ctx, id, before, saved);
  const view = (row: OrgRow) => ({ ...toDto(row) }) as Record<string, unknown>;
  const changes = diffFields(view(before), view(saved), [
    'slug',
    'name',
    'status',
    'defaultIdentityId',
    'branding',
  ]);
  if (Object.keys(changes).length > 0)
    await recordAudit(ctx, {
      ...auditActor(actor),
      orgId: id,
      action:
        input.status && input.status !== before.status ? statusAction(input.status) : 'org.update',
      targetType: 'org',
      targetId: id,
      detail: { changes },
    });
  return withUpdates(toDto(saved), passesToUpdate);
}

const statusAction = (status: 'active' | 'suspended') =>
  status === 'suspended' ? 'org.suspend' : 'org.reactivate';

/** Images are set only by the upload endpoint, so an update keeps the stored ones. */
function keepImages(next: Branding, stored: string): string {
  const { logo: _logo, icon: _icon, ...rest } = next;
  const prev = JSON.parse(stored) as Branding;
  return JSON.stringify({
    ...rest,
    ...(prev.logo ? { logo: prev.logo } : {}),
    ...(prev.icon ? { icon: prev.icon } : {}),
  });
}

/** Suspend: passes stop updating and the org's API keys stop working. */
export async function setOrgStatus(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  status: 'active' | 'suspended',
  admin?: OrgAdmin,
): Promise<OrgDto> {
  const before = await requireOrg(ctx, id);
  if (before.status === status) return toDto(before);
  const now = ctx.clock.now();
  const saved = admin
    ? (await moveOrgStatusAsAdmin(ctx, id, before.status, status, admin))
      ? await getOrgRow(ctx.env.DB, id)
      : null
    : await setOrgStatusRow(ctx.env.DB, id, status, now);
  if (!saved) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: id,
    action: statusAction(status),
    targetType: 'org',
    targetId: id,
    detail: { changes: { status: { from: before.status, to: status } } },
  });
  return toDto(saved);
}

/** Soft delete: passes and audit rows keep their org reference. */
export async function deleteOrg(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  admin?: OrgAdmin,
): Promise<void> {
  const row = await requireOrg(ctx, id);
  if (admin) await moveOrgStatusAsAdmin(ctx, id, row.status, 'deleted', admin);
  else await markOrgDeleted(ctx.env.DB, id, ctx.clock.now());
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: id,
    action: 'org.delete',
    targetType: 'org',
    targetId: id,
    detail: { slug: row.slug, name: row.name },
  });
}
