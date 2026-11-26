import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { resetScimTokenCache } from './scim-auth.ts';
import { rig } from './sync-test-fixtures.ts';

export const TOKEN = `scim-test-token-${'x'.repeat(32)}`;

/** The receiver on a rig: the app, the token on the env, and clean mirror, queue and counters. */
export async function scimRig(options: Parameters<typeof rig>[0] = { mode: 'live' }) {
  const r = await rig(options);
  Object.assign(r.f.env, { SCIM_BEARER_TOKEN: TOKEN });
  // Tokens are never deleted while live: retire, then remove.
  await run(
    env.DB,
    "UPDATE idp_scim_tokens SET state = 'retired', retired_at = 0 WHERE state != 'retired'",
  );
  resetScimTokenCache();
  for (const sql of [
    'DELETE FROM idp_scim_tokens',
    'DELETE FROM idp_directory_users',
    'DELETE FROM idp_directory_groups',
    'DELETE FROM idp_dirty',
    "DELETE FROM counters WHERE key LIKE 'idp:scim:%'",
  ])
    await run(env.DB, sql);
  return { r, app: createApp({ clock: r.f.clock }) };
}

export type ScimApp = Awaited<ReturnType<typeof scimRig>>;

export interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: SCIM bodies are asserted field by field
  body: any;
  headers: Headers;
}

/** One request to `/scim/v2`. `token: null` sends no Authorization header. */
export async function scim(
  s: ScimApp,
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string | null; ip?: string; raw?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { accept: 'application/scim+json' };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  const payload = opts.raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers['content-type'] = 'application/scim+json';
  const res = await s.app.request(
    `/scim/v2${path}`,
    { method, headers, ...(payload === undefined ? {} : { body: payload }) },
    s.r.f.env,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

interface Remote {
  id: string;
  externalId: string;
  meta: { lastModified: string };
  members?: { value: string }[];
}

export interface Stats {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  pages: number;
}

/**
 * Polaris ID's sync against the receiver, as `scimsync/service.go` runs it: list every page, create or replace what
 * is local (an update only when the local change is not older than the remote's `lastModified`), delete what is
 * remote only. Users go first; a group's members are the SCIM ids the receiver gave the users.
 */
export async function polarisSync(
  s: ScimApp,
  local: {
    users: { id: string; active: boolean; modified: number }[];
    groups: { id: string; members: string[]; modified: number }[];
  },
  count = 1000,
): Promise<Stats> {
  const stats: Stats = { created: 0, updated: 0, deleted: 0, skipped: 0, pages: 0 };
  const list = async (path: string): Promise<Remote[]> => {
    const out: Remote[] = [];
    for (let start = 1; ; ) {
      const page = await scim(s, 'GET', `${path}?startIndex=${start}&count=${count}`);
      stats.pages++;
      out.push(...page.body.Resources);
      if (out.length >= page.body.totalResults || page.body.Resources.length === 0) return out;
      start += page.body.itemsPerPage;
    }
  };
  const users = await list('/Users');
  const groups = await list('/Groups');
  const ids = new Map<string, string>();
  for (const u of local.users) {
    const have = users.find((r) => r.externalId === u.id);
    const body = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      externalId: u.id,
      userName: `name-${u.id}`,
      name: { givenName: 'Given', familyName: 'Family' },
      displayName: 'Display Name',
      active: u.active,
      emails: [{ value: `${u.id}@example.test`, primary: true }],
    };
    if (have && u.modified < Date.parse(have.meta.lastModified)) {
      stats.skipped++;
      ids.set(u.id, have.id);
      continue;
    }
    const reply = have
      ? await scim(s, 'PUT', `/Users/${have.id}`, body)
      : await scim(s, 'POST', '/Users', body);
    if (![200, 201].includes(reply.status)) throw new Error(`user push ${reply.status}`);
    stats[have ? 'updated' : 'created']++;
    ids.set(u.id, reply.body.id);
  }
  for (const r of users)
    if (!local.users.some((u) => u.id === r.externalId)) {
      const reply = await scim(s, 'DELETE', `/Users/${r.id}`);
      if (reply.status !== 204 && reply.status !== 404) throw new Error(`delete ${reply.status}`);
      stats.deleted++;
    }
  for (const g of local.groups) {
    const have = groups.find((r) => r.externalId === g.id);
    const body = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      externalId: g.id,
      displayName: 'Friendly Group',
      members: g.members.map((m) => ({ value: ids.get(m) ?? m })),
    };
    if (have && g.modified < Date.parse(have.meta.lastModified)) {
      stats.skipped++;
      continue;
    }
    const reply = have
      ? await scim(s, 'PUT', `/Groups/${have.id}`, body)
      : await scim(s, 'POST', '/Groups', body);
    if (![200, 201].includes(reply.status)) throw new Error(`group push ${reply.status}`);
    stats[have ? 'updated' : 'created']++;
  }
  for (const r of groups)
    if (!local.groups.some((g) => g.id === r.externalId)) {
      await scim(s, 'DELETE', `/Groups/${r.id}`);
      stats.deleted++;
    }
  return stats;
}

/** Everything the request path writes to the console, as lines. */
export function captureConsole(): string[] {
  const lines: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.join(' ')));
  return lines;
}
