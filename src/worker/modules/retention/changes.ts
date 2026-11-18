// What a settings save means for retention: bounds against the platform maximum, and a 7-day floor
// under every shortening so a mistaken save cannot delete data at once.
import {
  DATA_CLASSES,
  RETENTION_CLASSES,
  type RetentionClass,
} from '../../../shared/privacy/data-classes.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { platformPolicyOf } from './plan.ts';
import {
  type FloorChange,
  floorChange,
  type OrgRow,
  type PlatformPolicy,
  type Raw,
  resolveOrg,
} from './policy.ts';
import { readActiveOrgIds, readOneOrg, readOrgRows, readPlatformRaw } from './repo.ts';

export interface FloorWrite {
  orgId: string;
  cls: RetentionClass;
  change: FloorChange;
}
export interface ShortenNotice {
  orgId: string;
  cls: RetentionClass;
  days: number;
  from: number;
}
export interface RetentionIssue {
  path: string;
  message: string;
  code: string;
}
export interface RetentionChange {
  issues: RetentionIssue[];
  floors: FloorWrite[];
  notices: ShortenNotice[];
}

const EMPTY = (): RetentionChange => ({ issues: [], floors: [], notices: [] });
/** A platform change moves every org that follows a default: floors for more orgs than this are refused. */
export const MAX_FLOOR_ORGS = 400;

type Ok = Extract<PlatformPolicy, { ok: true }>;

function orgChange(
  ctx: ServiceContext,
  orgId: string,
  upserts: Record<string, unknown>,
  deletes: string[],
  platformRaw: ReadonlyMap<string, Raw>,
  org: Awaited<ReturnType<typeof readOneOrg>>,
): RetentionChange {
  const now = ctx.clock.now();
  const out = EMPTY();
  for (const cls of RETENTION_CLASSES) {
    const key = DATA_CLASSES[cls].key;
    const set = key in upserts;
    if (!set && !deletes.includes(key)) continue;
    const platform = platformPolicyOf(platformRaw, cls);
    if (!platform.ok) continue;
    if (set && (upserts[key] as number) > platform.maxDays) {
      out.issues.push({
        path: key,
        message: `The most allowed is ${platform.maxDays} days.`,
        code: 'RETENTION_ABOVE_MAX',
      });
      continue;
    }
    const base = { cls, platform, held: false, now } as const;
    const before = resolveOrg({
      ...base,
      orgRaw: org.raw.get(cls),
      floor: org.floors.get(cls) ?? null,
    });
    const after = resolveOrg({ ...base, orgRaw: set ? upserts[key] : undefined, floor: null });
    if (before.kind !== 'run' || after.kind !== 'run') continue;
    const change = floorChange(before.days, after.days, now);
    if (change.kind === 'set') {
      out.floors.push({ orgId, cls, change });
      out.notices.push({ orgId, cls, days: after.days, from: change.until });
    } else if (org.floors.has(cls)) out.floors.push({ orgId, cls, change });
  }
  return out;
}

async function platformChange(
  ctx: ServiceContext,
  upserts: Record<string, unknown>,
  deletes: string[],
  before: ReadonlyMap<string, Raw>,
): Promise<RetentionChange> {
  const now = ctx.clock.now();
  const out = EMPTY();
  const afterRaw = new Map(before);
  for (const [k, v] of Object.entries(upserts)) afterRaw.set(k, v);
  for (const k of deletes) afterRaw.delete(k);
  for (const cls of RETENTION_CLASSES) {
    const { key, maxKey } = DATA_CLASSES[cls];
    const touched = [key, maxKey].filter((k) => k in upserts || deletes.includes(k));
    if (touched.length === 0) continue;
    const was = platformPolicyOf(before, cls);
    const raw = afterRaw.get(key) ?? DATA_CLASSES[cls].platformDefault;
    const max = afterRaw.get(maxKey) ?? DATA_CLASSES[cls].platformMax;
    if (typeof raw === 'number' && typeof max === 'number' && raw > max) {
      out.issues.push({
        path: touched[0] ?? key,
        message: `The default (${raw} days) is above the maximum (${max} days).`,
        code: 'RETENTION_DEFAULT_ABOVE_MAX',
      });
      continue;
    }
    const next = platformPolicyOf(afterRaw, cls);
    if (!was.ok || !next.ok) continue;
    const rows = await orgsFor(ctx, cls, was, next);
    if (rows === 'too_many') {
      out.issues.push({
        path: touched[0] ?? key,
        message: 'Too many organizations to shorten retention safely. Ask engineering.',
        code: 'RETENTION_TOO_MANY_ORGS',
      });
      continue;
    }
    for (const row of rows) {
      const b = resolveOrg({
        cls,
        platform: was,
        orgRaw: row.raw,
        floor: row.floor,
        held: false,
        now,
      });
      const a = resolveOrg({ cls, platform: next, orgRaw: row.raw, floor: null, held: false, now });
      if (b.kind !== 'run' || a.kind !== 'run') continue;
      const change = floorChange(b.days, a.days, now);
      if (change.kind !== 'set') continue;
      out.floors.push({ orgId: row.orgId, cls, change });
      out.notices.push({ orgId: row.orgId, cls, days: a.days, from: change.until });
    }
  }
  return out;
}

/** Orgs whose effective days a platform change may lower: the ones with rows, and all when the default drops. */
async function orgsFor(
  ctx: ServiceContext,
  cls: RetentionClass,
  was: Ok,
  now: Ok,
): Promise<OrgRow[] | 'too_many'> {
  const rows = await readOrgRows(ctx.env.DB, cls, ctx.clock.now());
  if (now.defaultDays >= was.defaultDays) return rows;
  const ids = await readActiveOrgIds(ctx.env.DB, MAX_FLOOR_ORGS + 1);
  if (ids.length > MAX_FLOOR_ORGS) return 'too_many';
  const have = new Set(rows.map((r) => r.orgId));
  return [
    ...rows,
    ...ids
      .filter((id) => !have.has(id))
      .map((orgId) => ({ orgId, raw: undefined, floor: null, held: false })),
  ];
}

/**
 * Checks a validated save against the platform bounds and plans its floors. Org scope: a value above the
 * platform maximum is `RETENTION_ABOVE_MAX`. Platform scope: a default above its maximum is
 * `RETENTION_DEFAULT_ABOVE_MAX`; every org whose effective days drop gets a floor.
 */
export async function planRetentionChange(
  ctx: ServiceContext,
  scope: string,
  upserts: Record<string, unknown>,
  deletes: string[],
): Promise<RetentionChange> {
  const keys = RETENTION_CLASSES.flatMap(
    (c) => [DATA_CLASSES[c].key, DATA_CLASSES[c].maxKey] as string[],
  );
  const touches = (k: string) => keys.includes(k);
  if (![...Object.keys(upserts), ...deletes].some(touches)) return EMPTY();
  const platformRaw = await readPlatformRaw(ctx.env.DB);
  if (scope === 'platform') return platformChange(ctx, upserts, deletes, platformRaw);
  const orgId = scope.slice(4);
  return orgChange(
    ctx,
    orgId,
    upserts,
    deletes,
    platformRaw,
    await readOneOrg(ctx.env.DB, orgId, ctx.clock.now()),
  );
}
