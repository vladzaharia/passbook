import type { z } from 'zod';
import { OrgSettingsSchema, PlatformSettingsSchema } from '../../../shared/contracts/settings.ts';
import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import { ORG_WEBSITE_INVALID } from '../../../shared/copy/org-website.ts';
import { checkFromName } from '../../../shared/email-from-name.ts';
import type { Actor } from '../../platform/context.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import {
  FeatureNotIncludedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import { platformHostsOf, urlRefusal } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { purgeOrgBodies } from '../developer/repo-request-log.ts';
import { orgIsReadable } from '../orgs/repo.ts';
import { planRetentionChange } from '../retention/changes.ts';
import { enqueueShortenNotices } from '../retention/notify.ts';
import { inherit, planGateIssue, platformGateIssue, type SettingEntry } from './inherit.ts';
import { orgIdOfScope, registryFor } from './registry.ts';
import { isPlatformAddress } from './reply-to-domain.ts';
import {
  countEmailOnlyUsers,
  orgSettingsStmt,
  readOrgConfigRevision,
  readScopeRows,
  type SettingRow,
  type SettingsAdmin,
  type SettingsAuthority,
  type SettingsKey,
  writeScope,
} from './repo.ts';

export type { SettingEntry } from './inherit.ts';
export { platformSettingsStmt } from './repo.ts';
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

/** The org's settings read as a batch statement, or null while a fresh cached value exists. */
export function orgSettingsStmtIfCold(
  ctx: ServiceContext,
  orgId: string,
): D1PreparedStatement | null {
  const hit = cache.get(ctx.env.DB)?.get(`org:${orgId}`);
  const now = ctx.clock.now();
  if (hit && now >= hit.at && now - hit.at < CACHE_TTL_MS) return null;
  return orgSettingsStmt(ctx.env.DB, orgId);
}

/** Fills the cache from a `orgSettingsStmtIfCold` result, as `getOrgSettings` would have. */
export function primeOrgSettings(ctx: ServiceContext, orgId: string, result: D1Result): void {
  const scope = `org:${orgId}`;
  const byScope = cache.get(ctx.env.DB) ?? new Map();
  cache.set(ctx.env.DB, byScope);
  byScope.set(scope, {
    at: ctx.clock.now(),
    values: validStored(ctx, scope, result.results as SettingRow[]),
  });
}

/** Stored values that still pass their schema; unknown or invalid ones fall back to the default. */
function validStored(
  ctx: ServiceContext | undefined,
  scope: string,
  rows: readonly Pick<SettingRow, 'key' | 'value'>[],
): Record<string, unknown> {
  const registry = registryFor(scope);
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    const def = registry.get(row.key);
    const parsed = def?.schema.safeParse(JSON.parse(row.value));
    if (parsed?.success) values[row.key] = parsed.data;
    else if (ctx)
      ctx.log.warn('settings.invalid_stored_value', {
        code: 'SETTING_INVALID',
        scope,
        key: row.key,
      });
  }
  return values;
}

/** Decode a platform settings SELECT from D1.batch without consulting or populating the cache. */
export function decodePlatformSettings(result: D1Result): PlatformSettings {
  return PlatformSettingsSchema.parse(
    validStored(undefined, 'platform', result.results as Pick<SettingRow, 'key' | 'value'>[]),
  );
}

/** Stored values merged over schema defaults, cached per isolate for a few seconds. */
export async function getPlatformSettings(ctx: ServiceContext): Promise<PlatformSettings> {
  return PlatformSettingsSchema.parse(await readScope(ctx, 'platform'));
}

export async function getOrgSettings(ctx: ServiceContext, orgId: string): Promise<OrgSettings> {
  return OrgSettingsSchema.parse(await readScope(ctx, `org:${orgId}`));
}

async function assertScope(ctx: ServiceContext, scope: string): Promise<void> {
  const orgId = orgIdOfScope(scope);
  if (orgId && !(await orgIsReadable(ctx.env.DB, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
}

/** Stored values over registry defaults; no platform inheritance applied. */
async function listStored(ctx: ServiceContext, scope: string): Promise<SettingEntry[]> {
  await assertScope(ctx, scope);
  const stored = new Map((await readScopeRows(ctx.env.DB, scope)).map((row) => [row.key, row]));
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
      source: has ? 'org' : 'default',
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  });
}

export async function listSettings(ctx: ServiceContext, scope: string): Promise<SettingEntry[]> {
  const entries = await listStored(ctx, scope);
  const orgId = orgIdOfScope(scope);
  return orgId === null
    ? entries
    : inherit(entries, await getPlatformSettings(ctx), await entitlementsOf(ctx, orgId));
}

/** Private, local and platform hosts are no org website. */
function websiteRefusal(ctx: ServiceContext, url: string): string | null {
  return urlRefusal(new URL(url), platformHostsOf(ctx.env)) ? ORG_WEBSITE_INVALID : null;
}

/** The schema checks the name against "PassBook"; this also checks the platform's current sender name. */
async function fromNameRefusal(ctx: ServiceContext, name: string): Promise<string | null> {
  const platform = await getPlatformSettings(ctx);
  const checked = checkFromName(name, platform['email.senderName']);
  return checked.ok ? null : checked.error;
}

/**
 * The values of one save, checked: unknown keys, invalid values, and the platform and plan gates.
 * `null` resets a key to its default (a delete). Nothing is written.
 */
export async function checkValues(
  ctx: ServiceContext,
  scope: string,
  values: Record<string, unknown>,
): Promise<{ upserts: Record<string, unknown>; deletes: string[] }> {
  const orgId = orgIdOfScope(scope);
  await assertScope(ctx, scope);
  const registry = registryFor(scope);
  const issues: { path: string; message: string; code?: string }[] = [];
  const upserts: Record<string, unknown> = {};
  const deletes: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const def = registry.get(key);
    if (!def) {
      issues.push({ path: key, message: 'Unknown setting.', code: 'unknown_setting' });
    } else if (raw === null) {
      deletes.push(key);
    } else {
      const parsed = def.schema.safeParse(raw);
      const refused = !parsed.success
        ? null
        : key === 'email.fromName'
          ? await fromNameRefusal(ctx, parsed.data as string)
          : key === 'org.website'
            ? websiteRefusal(ctx, parsed.data as string)
            : key === 'support.email' && isPlatformAddress(ctx.env, parsed.data as string)
              ? 'Use an address on your own domain.'
              : null;
      if (refused) issues.push({ path: key, message: refused });
      else if (parsed.success) upserts[key] = parsed.data;
      else issues.push({ path: key, message: parsed.error.issues[0]?.message ?? 'Invalid value.' });
    }
  }
  if (issues.length) throw new ValidationError('Invalid settings.', issues, 'INVALID_SETTING');
  const plan = orgId === null ? null : await entitlementsOf(ctx, orgId);
  const gated =
    plan === null ? null : platformGateIssue(await getPlatformSettings(ctx), upserts, plan);
  if (gated) throw new ValidationError('Invalid settings.', [gated], gated.code);
  // The plan comes after the platform: a write the plan blocks is a 403 naming the feature, not a field error.
  const planned = plan === null ? null : planGateIssue(plan, upserts, deletes);
  if (planned) throw new FeatureNotIncludedError(planned.key, featureNotIncluded(planned.key));
  return { upserts, deletes };
}

/** `null` resets a key to its default. Unknown keys and invalid values reject the whole request. */
export async function updateSettings(
  ctx: ServiceContext,
  actor: Actor,
  input: { scope: string; values: Record<string, unknown>; configRevision?: number | undefined },
  authority?: SettingsAuthority,
  admin?: SettingsAdmin | SettingsKey,
): Promise<SettingEntry[]> {
  const { scope } = input;
  const orgId = orgIdOfScope(scope);
  if (
    authority &&
    (authority.kind !== 'session' ||
      authority.orgId !== orgId ||
      authority.capability !== 'org:manage' ||
      actor.type !== 'user' ||
      actor.id !== authority.userId)
  )
    throw new ForbiddenError();
  const { upserts, deletes } = await checkValues(ctx, scope, input.values);
  // Bounds against the platform maximum, and the floors that delay a shortening (retention keys only).
  const retention = await planRetentionChange(ctx, scope, upserts, deletes);
  const [first] = retention.issues;
  if (first) throw new ValidationError('Invalid settings.', retention.issues, first.code);

  const current = orgId === null ? null : await readOrgConfigRevision(ctx.env.DB, orgId);
  if (orgId !== null && current === null)
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  // The client's revision is the one its form was loaded with: older than the stored one is a 409.
  const revision = input.configRevision ?? current;
  const before = await listStored(ctx, scope);
  const written = await writeScope(
    ctx,
    scope,
    upserts,
    deletes,
    actor.id,
    revision,
    authority,
    admin,
    retention.floors,
    retention.platformRev,
  );
  if (!written) throw new ForbiddenError();
  clearSettingsCache(ctx.env.DB);
  const stored = await listStored(ctx, scope);

  const prior = new Map(before.map((e) => [e.key, e.value]));
  const wasStored = new Map(before.map((e) => [e.key, e.source === 'org']));
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const entry of stored) {
    // The org's zone defaults to Seattle: saving that value is a choice, so it is audited.
    const chosen =
      entry.key === 'org.timeZone' && wasStored.get(entry.key) !== (entry.source === 'org');
    if (chosen || JSON.stringify(prior.get(entry.key)) !== JSON.stringify(entry.value))
      changes[entry.key] = { from: prior.get(entry.key) ?? null, to: entry.value };
  }
  if (Object.keys(changes).length > 0)
    await recordAudit(ctx, {
      ...auditActor(actor),
      orgId,
      action: 'settings.update',
      targetType: 'settings',
      targetId: scope,
      detail: {
        changes,
        ...(retention.floors.length
          ? {
              retentionFloors: retention.floors.flatMap((f) =>
                f.change.kind === 'set'
                  ? [{ orgId: f.orgId, cls: f.cls, days: f.change.days, until: f.change.until }]
                  : [],
              ),
            }
          : {}),
      },
    });
  // Turning request bodies off blanks the ones already stored, so nothing outlives the switch.
  if (orgId !== null && changes['requestLog.bodies'] && changes['requestLog.bodies'].to !== true)
    await purgeOrgBodies(ctx.env.DB, orgId);
  await enqueueShortenNotices(ctx, retention.notices);
  return listSettings(ctx, scope);
}

/** The org's `config_revision` for an org scope, to send back with a save; absent for the platform. */
export async function settingsRevision(
  ctx: ServiceContext,
  scope: string,
): Promise<{ configRevision?: number }> {
  const orgId = orgIdOfScope(scope);
  const revision = orgId === null ? null : await readOrgConfigRevision(ctx.env.DB, orgId);
  return revision === null ? {} : { configRevision: revision };
}

/** What turning magic-link sign-in off would cost, for the confirm. */
export async function settingsImpact(ctx: ServiceContext): Promise<{ emailOnlyUsers: number }> {
  return { emailOnlyUsers: await countEmailOnlyUsers(ctx.env.DB) };
}
