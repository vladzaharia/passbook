import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  CreateOrgSchema,
  OrgBrandingSchema,
  OrgDto,
  UpdateOrgSchema,
} from '../../../shared/contracts/orgs.ts';
import { PERSONAL_ORG_COPY } from '../../../shared/copy/personal-org.ts';
import type { PlatformCaller } from '../../platform/actor.ts';
import type { Actor } from '../../platform/context.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PersonRequiredError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, diffFields, recordAudit } from '../audit/service.ts';
import { closeOrg } from '../org-lifecycle/service.ts';
import { markPassesStale } from './branding-stale.ts';
import { toDto } from './org-dto.ts';
import { requirePersonalOwner, requirePersonalStatusMove } from './personal-guard.ts';
import {
  countsFor,
  getOrgRow,
  identityUsableBy,
  listOrgRows,
  type OrgRow,
  slugTaken,
} from './repo.ts';
import {
  insertOrgAsAdmin,
  moveOrgStatusAsAdmin,
  type OrgAdmin,
  type OrgWriteAuthority,
  updateOrgRow,
} from './repo-org-writes.ts';
import { getPersonalUser, insertOrgWithCreator } from './repo-personal.ts';
import { plansOf } from './repo-usage.ts';
import { ownersOf, type Summary, summarize } from './service-summary.ts';

export { toDto };

type Branding = z.infer<typeof OrgBrandingSchema>;

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
    throw new NotFoundError(
      'Default identity not found for this organization.',
      'IDENTITY_NOT_FOUND',
      [{ path: 'defaultIdentityId', message: 'Unknown identity.' }],
    );
}

async function checkSlug(ctx: ServiceContext, slug: string, exceptId?: string) {
  // The personal- namespace belongs to personal orgs, which keep their own slug when renamed.
  if (slug.startsWith(PERSONAL_ORG_COPY.slugPrefix))
    throw new BadRequestError(PERSONAL_ORG_COPY.slugReserved, 'ORG_SLUG_RESERVED');
  if (await slugTaken(ctx.env.DB, slug, exceptId))
    throw new ConflictError('That slug is taken.', 'ORG_SLUG_TAKEN');
}

export async function listOrgs(
  ctx: ServiceContext,
  query: { cursor?: string; limit: number; q?: string; sandboxes?: 'hide' | 'show' | 'only' },
  mode: Mode = 'live',
): Promise<{ items: Summary[]; nextCursor: string | null }> {
  const rows = await listOrgRows(
    ctx.env.DB,
    query.cursor,
    query.limit + 1,
    query.q,
    query.sandboxes,
  );
  const page = rows.slice(0, query.limit);
  const counts = await countsFor(
    ctx.env.DB,
    page.map((r) => r.id),
    mode,
  );
  const owners = await ownersOf(ctx, page);
  const plans = await plansOf(
    ctx.env.DB,
    page.map((r) => r.id),
  );
  return {
    items: page.map((row) => summarize(row, counts.get(row.id), owners, plans)),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getOrg(
  ctx: ServiceContext,
  id: string,
  mode: Mode = 'live',
  platform?: { userId: string; afterStatus?: true },
): Promise<Summary> {
  const row = await requireOrg(ctx, id);
  if (platform && !platform.afterStatus)
    requirePersonalOwner(row.personal_user_id, platform.userId);
  return summarize(
    row,
    (await countsFor(ctx.env.DB, [id], mode)).get(id),
    platform ? await ownersOf(ctx, [row]) : undefined,
    platform ? await plansOf(ctx.env.DB, [id]) : undefined,
  );
}

export async function createOrg(
  ctx: ServiceContext,
  actor: Actor,
  input: z.infer<typeof CreateOrgSchema>,
  admin: PlatformCaller,
): Promise<OrgDto> {
  // A key is nobody's member: it cannot add a person to the org it makes.
  if (input.addMe === true && admin.userId === null)
    throw new ValidationError(
      'A platform key cannot add itself to an organization. Send addMe false.',
      [{ path: 'addMe', message: 'Not allowed for a platform key.' }],
      'ORG_ADD_ME_NEEDS_PERSON',
    );
  await checkSlug(ctx, input.slug);
  await checkIdentity(ctx, null, input.defaultIdentityId ?? null);
  const now = ctx.clock.now();
  const row: OrgRow = {
    id: ctx.ids.id(),
    slug: input.slug,
    name: input.name,
    status: 'active',
    default_identity_id: input.defaultIdentityId ?? null,
    // The web logo is set only by its upload, which checks the PNG.
    branding: JSON.stringify((({ web: _web, ...rest }) => rest)(input.branding ?? {})),
    created_at: now,
    updated_at: now,
    config_revision: 1,
    personal_user_id: null,
    kind: 'standard',
  };
  const preset = input.preset ?? 'standard';
  const addMe = input.addMe ?? admin.userId !== null;
  const me = addMe && admin.userId ? await getPersonalUser(ctx.env.DB, admin.userId) : null;
  if (me?.status === 'active')
    await insertOrgWithCreator(ctx, row, admin, preset, {
      userId: me.id,
      email: me.primary_email,
      invitationId: ctx.ids.id(),
      membershipId: ctx.ids.id(),
      tokenHash: await sha256Hex(ctx.ids.token(32)),
    });
  else await insertOrgAsAdmin(ctx, row, admin, preset);
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: row.id,
    action: 'org.create',
    targetType: 'org',
    targetId: row.id,
    detail: { slug: row.slug, name: row.name, preset, addMe: me?.status === 'active' },
  });
  return toDto(row);
}

export async function updateOrg(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: z.infer<typeof UpdateOrgSchema>,
  authority: OrgWriteAuthority,
  admin?: OrgAdmin,
): Promise<OrgDto> {
  const before = await requireOrg(ctx, id);
  const toStatus =
    input.status !== undefined && input.status !== before.status ? input.status : null;
  // A status move is the platform operation of POST /status, with the same grant and audit.
  if (toStatus && !admin) throw new ForbiddenError();
  const edits =
    input.slug !== undefined ||
    input.name !== undefined ||
    input.defaultIdentityId !== undefined ||
    input.branding !== undefined;
  // Two commits can half-apply, so a status move travels alone.
  if (toStatus && edits)
    throw new BadRequestError(
      'Send the status change on its own, then the other edits.',
      'ORG_STATUS_ALONE',
    );
  if (
    toStatus &&
    input.configRevision !== undefined &&
    input.configRevision !== before.config_revision
  )
    throw new ConflictError('The organization changed. Reload and retry.', 'SETTINGS_CHANGED');
  let out: OrgDto = toDto(before);
  if (edits || !toStatus) {
    if (input.slug !== undefined && input.slug !== before.slug)
      await checkSlug(ctx, input.slug, id);
    if (input.defaultIdentityId !== undefined)
      await checkIdentity(ctx, id, input.defaultIdentityId);
    const next: OrgRow = {
      ...before,
      slug: input.slug ?? before.slug,
      name: input.name ?? before.name,
      default_identity_id:
        input.defaultIdentityId === undefined
          ? before.default_identity_id
          : input.defaultIdentityId,
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
      'defaultIdentityId',
      'branding',
    ]);
    if (Object.keys(changes).length > 0)
      await recordAudit(ctx, {
        ...auditActor(actor),
        orgId: id,
        action: 'org.update',
        targetType: 'org',
        targetId: id,
        detail: { changes },
      });
    out = withUpdates(toDto(saved), passesToUpdate);
  }
  if (toStatus && admin) out = { ...out, ...(await setOrgStatus(ctx, actor, id, toStatus, admin)) };
  return out;
}

const statusAction = (status: 'active' | 'suspended') =>
  status === 'suspended' ? 'org.suspend' : 'org.reactivate';

/** Images are set only by the upload endpoint, so an update keeps the stored ones. */
function keepImages(next: Branding, stored: string): string {
  const { logo: _logo, icon: _icon, web: _web, mark: _mark, ...rest } = next;
  const prev = JSON.parse(stored) as Branding;
  return JSON.stringify({
    ...rest,
    ...(prev.logo ? { logo: prev.logo } : {}),
    ...(prev.icon ? { icon: prev.icon } : {}),
    ...(prev.web ? { web: prev.web } : {}),
    ...(prev.mark ? { mark: prev.mark } : {}),
  });
}

/** Suspend: passes stop updating and the org's API keys stop working. */
export async function setOrgStatus(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  status: 'active' | 'suspended',
  admin: PlatformCaller,
): Promise<OrgDto> {
  const before = await requireOrg(ctx, id);
  // A personal org is its owner's and the platform admins': a key never moves it (P3).
  if (admin.userId === null && before.personal_user_id !== null) throw new PersonRequiredError();
  await requirePersonalStatusMove(ctx.env.DB, before, status, admin.userId ?? '');
  const entry = {
    ...auditActor(actor),
    orgId: id,
    action: statusAction(status),
    targetType: 'org',
    targetId: id,
    detail: {
      changes: { status: { from: before.status, to: status } },
      ...(before.personal_user_id
        ? { personal: true, override: before.personal_user_id !== admin.userId }
        : {}),
    },
  };
  if (before.status === status) {
    // An admin's suspend of an org the owner already suspended is still recorded: the owner cannot lift it after.
    if (
      status === 'suspended' &&
      before.personal_user_id &&
      before.personal_user_id !== admin.userId
    )
      await recordAudit(ctx, entry);
    return toDto(before);
  }
  const saved = (await moveOrgStatusAsAdmin(ctx, id, before.status, status, admin, entry))
    ? await getOrgRow(ctx.env.DB, id)
    : null;
  if (!saved) {
    // The org moved under us (status, deletion): a gone org is a 404, a changed one a conflict.
    const now = await getOrgRow(ctx.env.DB, id);
    if (!now || now.status === 'deleted')
      throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
    throw new ConflictError('The organization changed. Reload and retry.', 'ORG_CONFLICT');
  }
  return toDto(saved);
}

/** Closes the org (the lifecycle module owns it): read-only, 30 days to export, then purge. */
export async function deleteOrg(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  admin: OrgAdmin,
): Promise<void> {
  await closeOrg(ctx, actor, id, { kind: 'platform', ...admin });
}
