import type { z } from 'zod';
import { OrgSettingsSchema, PlatformSettingsSchema } from '../../../shared/contracts/settings.ts';
import type { Actor } from '../../platform/context.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { orgIsReadable } from '../orgs/repo.ts';
import { orgIdOfScope, registryFor } from './registry.ts';
import { countEmailOnlyUsers, readScopeRows, type SettingRow, writeScope } from './repo.ts';

export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

const CACHE_TTL_MS = 5000;
const cache = new WeakMap<
  D1Database,
  Map<string, { at: number; values: Record<string, unknown> }>
>();

/** Drops cached settings for this isolate (tests, and after every write). */
export function clearSettingsCache(db?: D1Database): void {
  if (db) cache.delete(db);
}

async function readScope(ctx: ServiceContext, scope: string): Promise<Record<string, unknown>> {
  const now = ctx.clock.now();
  const byScope = cache.get(ctx.env.DB) ?? new Map();
  cache.set(ctx.env.DB, byScope);
  const hit = byScope.get(scope);
  if (hit && now >= hit.at && now - hit.at < CACHE_TTL_MS) return hit.values;
  const values = validStored(ctx, scope, await readScopeRows(ctx.env.DB, scope));
  byScope.set(scope, { at: now, values });
  return values;
}

/** Stored values that still pass their schema; unknown or invalid ones fall back to the default. */
function validStored(
  ctx: ServiceContext,
  scope: string,
  rows: SettingRow[],
): Record<string, unknown> {
  const registry = registryFor(scope);
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    const def = registry.get(row.key);
    const parsed = def?.schema.safeParse(JSON.parse(row.value));
    if (parsed?.success) values[row.key] = parsed.data;
    else
      ctx.log.warn('settings.invalid_stored_value', {
        code: 'SETTING_INVALID',
        scope,
        key: row.key,
      });
  }
  return values;
}

/** Stored values merged over schema defaults, cached per isolate for a few seconds. */
export async function getPlatformSettings(ctx: ServiceContext): Promise<PlatformSettings> {
  return PlatformSettingsSchema.parse(await readScope(ctx, 'platform'));
}

export async function getOrgSettings(ctx: ServiceContext, orgId: string): Promise<OrgSettings> {
  return OrgSettingsSchema.parse(await readScope(ctx, `org:${orgId}`));
}

export interface SettingEntry {
  scope: string;
  key: string;
  value: unknown;
  default?: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
}

async function assertScope(ctx: ServiceContext, scope: string): Promise<void> {
  const orgId = orgIdOfScope(scope);
  if (orgId && !(await orgIsReadable(ctx.env.DB, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
}

export async function listSettings(ctx: ServiceContext, scope: string): Promise<SettingEntry[]> {
  await assertScope(ctx, scope);
  const stored = new Map((await readScopeRows(ctx.env.DB, scope)).map((r) => [r.key, r]));
  const registry = registryFor(scope);
  const validated = validStored(ctx, scope, [...stored.values()]);
  return [...registry.values()].map((def) => {
    const row = stored.get(def.key);
    const has = def.key in validated;
    return {
      scope,
      key: def.key,
      value: has ? validated[def.key] : (def.default ?? null),
      ...(def.default !== undefined ? { default: def.default } : {}),
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  });
}

/** `null` resets a key to its default. Unknown keys and invalid values reject the whole request. */
export async function updateSettings(
  ctx: ServiceContext,
  actor: Actor,
  input: { scope: string; values: Record<string, unknown> },
): Promise<SettingEntry[]> {
  const { scope } = input;
  await assertScope(ctx, scope);
  const registry = registryFor(scope);
  const issues: { path: string; message: string; code?: string }[] = [];
  const upserts: Record<string, unknown> = {};
  const deletes: string[] = [];
  for (const [key, raw] of Object.entries(input.values)) {
    const def = registry.get(key);
    if (!def) {
      issues.push({ path: key, message: 'Unknown setting.', code: 'unknown_setting' });
    } else if (raw === null) {
      deletes.push(key);
    } else {
      const parsed = def.schema.safeParse(raw);
      if (parsed.success) upserts[key] = parsed.data;
      else issues.push({ path: key, message: parsed.error.issues[0]?.message ?? 'Invalid value.' });
    }
  }
  if (issues.length) throw new ValidationError('Invalid settings.', issues, 'INVALID_SETTING');

  const before = await listSettings(ctx, scope);
  await writeScope(ctx.env.DB, scope, upserts, deletes, actor.id, ctx.clock.now());
  clearSettingsCache(ctx.env.DB);
  const after = await listSettings(ctx, scope);

  const prior = new Map(before.map((e) => [e.key, e.value]));
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const entry of after) {
    if (JSON.stringify(prior.get(entry.key)) !== JSON.stringify(entry.value))
      changes[entry.key] = { from: prior.get(entry.key) ?? null, to: entry.value };
  }
  if (Object.keys(changes).length > 0)
    await recordAudit(ctx, {
      ...auditActor(actor),
      orgId: orgIdOfScope(scope),
      action: 'settings.update',
      targetType: 'settings',
      targetId: scope,
      detail: { changes },
    });
  return after;
}

/** What turning magic-link sign-in off would cost, for the confirm. */
export async function settingsImpact(ctx: ServiceContext): Promise<{ emailOnlyUsers: number }> {
  return { emailOnlyUsers: await countEmailOnlyUsers(ctx.env.DB) };
}
