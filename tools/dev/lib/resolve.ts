// Resolves route placeholders ({passId}, {passToken}, ...) from the admin API, once per run.
import type { APIRequestContext } from '@playwright/test';

type Json = Record<string, unknown>;
type Ctx = {
  platform: () => Promise<APIRequestContext>;
  org: () => Promise<APIRequestContext>;
  holder: () => Promise<APIRequestContext>;
};

const last = (url: unknown): string | undefined =>
  typeof url === 'string' ? url.split('/').filter(Boolean).pop()?.split('?')[0] : undefined;

async function list(ctx: APIRequestContext, path: string): Promise<Json[]> {
  const res = await ctx.get(path);
  if (!res.ok()) return [];
  const body = (await res.json()) as { items?: Json[] };
  return body.items ?? [];
}

const id = (row: Json | undefined) => (typeof row?.id === 'string' ? row.id : undefined);

/** Org-scoped endpoints need ?orgId=; try each org (henrys first) until one has a row. */
async function firstInOrgs(
  ctx: Ctx,
  path: string,
  pick: (row: Json) => string | undefined = id,
): Promise<string | undefined> {
  const orgs = await list(await ctx.platform(), '/api/v1/orgs');
  orgs.sort((a, b) => Number(b.slug === 'henrys') - Number(a.slug === 'henrys'));
  const org = await ctx.org();
  for (const o of orgs) {
    const sep = path.includes('?') ? '&' : '?';
    for (const row of await list(org, `${path}${sep}limit=20&orgId=${o.id}`)) {
      const value = pick(row);
      if (value) return value;
    }
  }
  return undefined;
}

async function joinToken(ctx: Ctx): Promise<string | undefined> {
  const org = await ctx.org();
  const orgs = await list(await ctx.platform(), '/api/v1/orgs');
  for (const o of orgs) {
    for (const t of await list(org, `/api/v1/templates?limit=50&orgId=${o.id}`)) {
      const res = await org.get(
        `/api/v1/join-links/${encodeURIComponent(String(t.id))}?orgId=${o.id}`,
      );
      if (!res.ok()) continue;
      const url = last((((await res.json()) as Json).link as Json | null)?.url);
      if (url) return url;
    }
  }
  return undefined;
}

/** The row named `name` in an org-scoped list, searching every org. */
const named = (path: string, name: string) => (c: Ctx) =>
  firstInOrgs(c, path, (r) => (r.name === name ? id(r) : undefined));

/** A pass issued from the template named `name` (the paper channel is on for the coupon). */
async function passOf(ctx: Ctx, name: string): Promise<string | undefined> {
  const org = await ctx.org();
  for (const o of await list(await ctx.platform(), '/api/v1/orgs')) {
    const template = (await list(org, `/api/v1/templates?limit=100&orgId=${o.id}`)).find(
      (t) => t.name === name,
    );
    if (!template) continue;
    const passes = await list(org, `/api/v1/passes?limit=200&orgId=${o.id}`);
    return id(passes.find((p) => p.templateId === template.id));
  }
  return undefined;
}

async function orgBySlug(ctx: Ctx, slug: string): Promise<string | undefined> {
  return id((await list(await ctx.platform(), '/api/v1/orgs')).find((o) => o.slug === slug));
}

const SOURCES: Record<string, (ctx: Ctx) => Promise<string | undefined>> = {
  orgId: (c) => firstInOrgs(c, '/api/v1/passes', (r) => String(r.orgId)),
  passId: (c) => firstInOrgs(c, '/api/v1/passes'),
  paperPassId: (c) => passOf(c, 'Northwind Coupon'),
  passToken: async (c) => {
    const passId = await SOURCES.passId?.(c);
    if (!passId) return undefined;
    const res = await (await c.org()).get(`/api/v1/passes/${passId}`);
    return res.ok() ? last(((await res.json()) as Json).publicUrl) : undefined;
  },
  templateId: (c) => firstInOrgs(c, '/api/v1/templates'),
  blueprintId: async (c) =>
    id((await list(await c.platform(), '/api/v1/templates?blueprint=true&limit=1'))[0]),
  connectionId: (c) => firstInOrgs(c, '/api/v1/connections'),
  keyId: (c) => firstInOrgs(c, '/api/v1/api-keys'),
  platformKeyId: async (c) =>
    id((await list(await c.platform(), '/api/v1/api-keys?orgId=null&limit=1'))[0]),
  endpointId: (c) => firstInOrgs(c, '/api/v1/webhook-endpoints'),
  northwindId: (c) => orgBySlug(c, 'northwind'),
  harborId: (c) => orgBySlug(c, 'harbor-lights'),
  frontDoorId: named('/api/v1/scanning-sessions', 'Front door'),
  eveningSessionId: named('/api/v1/scanning-sessions', 'Evening classes'),
  memberTemplateId: named('/api/v1/templates', 'Northwind Member'),
  monitorId: named('/api/v1/scan-setups', 'Lobby monitor'),
  sessionId: (c) => firstInOrgs(c, '/api/v1/scanning-sessions'),
  eventId: (c) => firstInOrgs(c, '/api/v1/scan-events'),
  scannerId: (c) => firstInOrgs(c, '/api/v1/scanners'),
  broadcastId: (c) => firstInOrgs(c, '/api/v1/broadcasts'),
  runId: (c) => firstInOrgs(c, '/api/v1/broadcasts'),
  importId: (c) => firstInOrgs(c, '/api/v1/pass-imports'),
  bundleToken: (c) => firstInOrgs(c, '/api/v1/bundles', (r) => last(r.url)),
  joinToken,
  userId: async (c) => id((await list(await c.platform(), '/api/v1/users?limit=1'))[0]),
  groupKey: async (c) => {
    const res = await (await c.platform()).get('/api/v1/idp/groups');
    if (!res.ok()) return undefined;
    const rows = ((await res.json()) as { items?: { key?: string; kind?: string }[] }).items ?? [];
    return (rows.find((r) => r.kind === 'custom') ?? rows[0])?.key;
  },
  identityId: async (c) => {
    const rows = await list(await c.platform(), '/api/v1/identities?limit=20');
    return id(rows.find((r) => r.id !== 'platform') ?? rows[0]);
  },
  /** A Workbench tool name: the tool entry redirect picks the remembered context. */
  wbTool: async () => 'logs',
  myPassId: async (c) => id((await list(await c.holder(), '/api/v1/me/passes?limit=1'))[0]),
};

export const knownPlaceholders = () => Object.keys(SOURCES);

export async function resolvePlaceholders(
  ctx: Ctx,
  needed: Iterable<string>,
): Promise<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};
  for (const key of new Set(needed)) {
    try {
      values[key] = await SOURCES[key]?.(ctx);
    } catch (error) {
      console.warn(`Could not resolve {${key}}: ${(error as Error).message}`);
    }
  }
  return values;
}
