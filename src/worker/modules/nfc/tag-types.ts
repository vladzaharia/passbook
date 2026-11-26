import type { z } from 'zod';
import type {
  CreateTagTypeSchema,
  TagType,
  UpdateTagTypeSchema,
} from '../../../shared/contracts/nfc-tag-admin.ts';
import { type AuthContext, assertOrgAccess } from '../../platform/auth.ts';
import { grant } from '../../platform/authority.ts';
import type { Actor } from '../../platform/context.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  UnauthenticatedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import {
  countOrgTemplates,
  getTagType,
  insertTagType,
  setTypeTemplates,
  systemEnabled,
  tagTypeNamesTemplate,
  updateTagType,
} from './repo-tag-types.ts';

export const tagTypeNotFound = () => new NotFoundError('Tag type not found.', 'TAG_TYPE_NOT_FOUND');

/**
 * A session needs the capability through its membership (a non-member gets a 404); an API key of another org, or a platform key,
 * gets the same 404; an API key needs the
 * scope the route guard verified: `scans:read` to read, `scanning:write` to change.
 */
export async function tagTypeAccess(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
  capability: 'scanning:read' | 'scanning:manage',
  notFound: () => Error = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND'),
): Promise<TenantPassWrite> {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind === 'scanner') throw new ForbiddenError();
  if (auth.kind === 'session' && !(await getOrgAccess(ctx, auth.userId, orgId))) throw notFound();
  if (auth.kind === 'api_key' && auth.orgId !== orgId) throw notFound();
  assertOrgAccess(auth, orgId);
  return tenantAuthorityOf(ctx, auth, orgId, capability);
}

const TABLES = ['nfc_tag_types', 'nfc_tag_type_templates'] as const;

function typeGrant(ctx: ServiceContext, authority: TenantPassWrite, action: string) {
  return grant(ctx, {
    purpose: `org.nfc.tag_type.${action}`,
    principal: tenantPrincipal(authority),
    checks: capabilityChecks(authority),
    codes: { lineage: 'TAG_TYPE_CHANGED', stale: 'TAG_TYPE_CHANGED' },
    tables: TABLES,
  });
}

function audit(
  ctx: ServiceContext,
  g: ReturnType<typeof typeGrant>,
  actor: Actor,
  orgId: string,
  action: string,
  id: string,
  detail: Record<string, unknown>,
) {
  g.audit({
    at: ctx.clock.now(),
    orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: `nfc.tag_type.${action}`,
    targetType: 'nfc_tag_type',
    targetId: id,
    requestId: null,
    ipPrefix: null,
    detail: JSON.stringify({ id, ...detail }),
  });
}

async function checkTemplates(ctx: ServiceContext, orgId: string, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  if ((await countOrgTemplates(ctx.env.DB, orgId, unique)) !== unique.length)
    throw new ValidationError(
      'A template does not belong to this organization.',
      [{ path: 'templateIds', message: 'Unknown template', code: 'custom' }],
      'UNKNOWN_TEMPLATE',
    );
  return unique;
}

/** Name taken, a disabled system and a stale version are conflicts; anything else is the grant's. */
async function commit(
  ctx: ServiceContext,
  g: ReturnType<typeof typeGrant>,
  orgId: string,
  id: string,
): Promise<void> {
  try {
    await g.commit();
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError('A tag type with this name exists.', 'TAG_TYPE_NAME_TAKEN');
    if (error instanceof Error && /tag_system_disabled/.test(error.message))
      throw new ConflictError('This tag system is not available.', 'TAG_SYSTEM_DISABLED');
    if (error instanceof AppError && error.code === 'TAG_TYPE_CHANGED') {
      const now = await getTagType(ctx.env.DB, orgId, id);
      if (!now) throw tagTypeNotFound();
      if (now.archivedAt !== null) throw archived();
      throw new PreconditionFailedError('The tag type changed. Reload and retry.');
    }
    throw g.translate(error);
  }
}

const archived = () => new ConflictError('This tag type is archived.', 'TAG_TYPE_ARCHIVED');

export async function createTagType(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  input: z.infer<typeof CreateTagTypeSchema>,
): Promise<TagType> {
  const { orgId } = authority;
  assertLoanerScope(input.use, input.scopes, 'scopes');
  const templateIds = await checkTemplates(ctx, orgId, input.templateIds);
  if (!(await systemEnabled(ctx.env.DB, input.system)))
    throw new ConflictError('This tag system is not available.', 'TAG_SYSTEM_DISABLED');
  const id = ctx.ids.id();
  const g = typeGrant(ctx, authority, 'create');
  insertTagType(g, {
    id,
    system: input.system,
    name: input.name,
    use: input.use,
    scopes: input.scopes,
    perPass: input.perPass,
    bindingDays: input.bindingDays,
    confirm: input.confirm,
    typed: input.typed,
    createdBy: actor.id ?? 'system',
    now: ctx.clock.now(),
  });
  if (templateIds.length > 0) setTypeTemplates(g, id, templateIds);
  audit(ctx, g, actor, orgId, 'create', id, { name: input.name, system: input.system });
  await commit(ctx, g, orgId, id);
  const created = await getTagType(ctx.env.DB, orgId, id);
  if (!created) throw tagTypeNotFound();
  ctx.log.info('nfc.tag_type_created', { orgId, typeId: id });
  return created;
}

/** A loaner is lent to a pass, never to a person: its type takes pass scope only. */
function assertLoanerScope(use: string, scopes: string, path: 'scopes' | 'use') {
  if (use === 'visitor' && scopes !== 'pass')
    throw new ValidationError(
      'A visitor tag type is assigned to a pass only.',
      [{ path, message: 'Visitor tag types take pass scope only.', code: 'custom' }],
      'TAG_TYPE_LOANER_SCOPE',
    );
}

const COLUMNS = {
  name: 'name',
  use: 'use',
  scopes: 'scopes',
  perPass: 'per_pass',
  bindingDays: 'binding_days',
  confirm: 'confirm',
} as const;

export async function updateType(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  id: string,
  input: z.infer<typeof UpdateTagTypeSchema>,
): Promise<TagType> {
  const { orgId } = authority;
  const current = await getTagType(ctx.env.DB, orgId, id);
  if (!current) throw tagTypeNotFound();
  if (current.archivedAt !== null) throw archived();
  if (input.typed === true && current.system !== 'uid')
    throw new ValidationError('Secure tags cannot be typed.', [
      { path: 'typed', message: 'Secure tags cannot be typed.', code: 'custom' },
    ]);
  if (input.use !== undefined || input.scopes !== undefined)
    assertLoanerScope(
      input.use ?? current.use,
      input.scopes ?? current.scopes,
      input.scopes === undefined ? 'use' : 'scopes',
    );
  const templateIds =
    input.templateIds === undefined
      ? undefined
      : await checkTemplates(ctx, orgId, input.templateIds);
  const set: Record<string, string | number | null> = { updated_at: ctx.clock.now() };
  const changed: string[] = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = input[key as keyof typeof COLUMNS];
    if (value === undefined) continue;
    set[column] = value;
    changed.push(key);
  }
  if (input.typed !== undefined) {
    set.typed = input.typed ? 1 : 0;
    changed.push('typed');
  }
  if (templateIds) changed.push('templateIds');
  const g = typeGrant(ctx, authority, 'update');
  updateTagType(g, id, input.version, set);
  if (templateIds) setTypeTemplates(g, id, templateIds);
  audit(ctx, g, actor, orgId, 'update', id, { changed });
  await commit(ctx, g, orgId, id);
  const updated = await getTagType(ctx.env.DB, orgId, id);
  if (!updated) throw tagTypeNotFound();
  return updated;
}

/** Existing tags keep working under the type's last rules; no new binds of it. */
export async function archiveTagType(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  id: string,
  version: number,
): Promise<TagType> {
  const { orgId } = authority;
  const current = await getTagType(ctx.env.DB, orgId, id);
  if (!current) throw tagTypeNotFound();
  if (current.archivedAt !== null) return current;
  const now = ctx.clock.now();
  const g = typeGrant(ctx, authority, 'archive');
  updateTagType(g, id, version, { archived_at: now, updated_at: now });
  audit(ctx, g, actor, orgId, 'archive', id, { name: current.name, tags: current.tagCount });
  await commit(ctx, g, orgId, id);
  const result = await getTagType(ctx.env.DB, orgId, id);
  if (!result) throw tagTypeNotFound();
  return result;
}

/**
 * Refuses removing a template that a tag type names (0128 keeps such a template). `live` skips archived
 * types, which the foreign key still guards on a hard delete.
 */
export async function assertTemplateFreeOfTagTypes(
  ctx: ServiceContext,
  templateId: string,
  live: boolean,
): Promise<void> {
  if (await tagTypeNamesTemplate(ctx.env.DB, templateId, live))
    throw new ConflictError(
      'A tag type uses this template. Remove it from the type first.',
      'TEMPLATE_IN_TAG_TYPE',
    );
}
