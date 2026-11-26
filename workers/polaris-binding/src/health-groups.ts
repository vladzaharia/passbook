import { failure, ok, type Req } from './pocket-http.ts';
import { HEALTH_TTL } from './policy.ts';
import { ID, type Registry, type Settings } from './registry.ts';
import type { Routes } from './routes.ts';
import {
  abandonIntent,
  listGroupRows,
  recordAdopted,
  setGroupBack,
  setGroupGone,
  setGroupLive,
  setMissingSince,
} from './store-groups.ts';
import { IdpError } from './types.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const unexpected = () =>
  new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group list.');

interface Item {
  id: string;
  name: string;
  createdAt: number;
}

/** A page of the group list, strictly. The list answers a minimal DTO: no member arrays. */
function items(body: unknown): Item[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw unexpected();
  return data.map((g) => {
    const v = g as { id?: unknown; name?: unknown; createdAt?: unknown } | null;
    if (typeof v?.id !== 'string' || !ID.test(v.id) || typeof v.name !== 'string')
      throw unexpected();
    return { id: v.id, name: v.name, createdAt: Date.parse(String(v.createdAt)) };
  });
}

/** What a settled intent must look like: made since the intent, the friendly name asked for, and empty. */
const SLACK = 5_000;

/**
 * A crash between the intent and its read-back leaves a pending row. Exactly one group with the exact name, made
 * since the intent, with the friendly name the intent asked for and no members or clients, is the binding's own.
 * None, or one that does not match, means the POST never landed. Only the binding's own pending name is recorded.
 */
export async function settlePending(db: D1Database, r: Routes, req: Req): Promise<void> {
  for (const row of (await listGroupRows(db)).filter((x) => x.state === 'pending')) {
    const res = await req('GET', r.groupSearch(row.name));
    if (!ok(res)) throw failure(res);
    const hits = items(res.body).filter(
      (g) => g.name === row.name && g.createdAt >= row.createdAt - SLACK,
    );
    if (hits.length > 1) continue;
    const hit = hits[0];
    if (!hit) {
      await abandonIntent(db, row.key);
      continue;
    }
    const full = await req('GET', r.group(hit.id));
    if (!ok(full)) throw failure(full);
    const g = full.body as {
      friendlyName?: unknown;
      users?: unknown;
      allowedOidcClients?: unknown;
    } | null;
    const empty =
      Array.isArray(g?.users) &&
      g.users.length === 0 &&
      Array.isArray(g.allowedOidcClients) &&
      g.allowedOidcClients.length === 0;
    if (empty && (row.friendlyName === null || g?.friendlyName === row.friendlyName))
      await setGroupLive(db, row.key, hit.id);
    else await abandonIntent(db, row.key);
  }
}

/** The name of a group by id from the list pages, or null. */
async function nameFromList(req: Req, r: Routes, id: string): Promise<string | null> {
  for (let page = 1; page <= 5; page++) {
    const res = await req('GET', r.groupPage(page));
    if (!ok(res)) throw failure(res);
    const list = items(res.body);
    const hit = list.find((g) => g.id === id);
    if (hit) return hit.name;
    if (list.length < 100) break;
  }
  return null;
}

/**
 * First sight of an adopted group: its name is recorded, and later writes need the live name to match. A name
 * inside the namespace, one that reads as an admin group, or one a registry or protected group has is refused:
 * it is never recorded, so never written. Returns the refused targets.
 */
export async function recordAdoptedNames(
  db: D1Database,
  r: Routes,
  settings: Settings,
  base: Registry,
  groupPrefix: string,
  req: Req,
  at: number,
): Promise<string[]> {
  const known = new Set(
    (await listGroupRows(db)).filter((x) => x.kind === 'adopted').map((x) => x.key),
  );
  const taken = [
    ...base.entries.map((e) => e.name),
    ...base.unplaced.map((u) => u.name),
    ...base.unplacedProtected.map((u) => u.name),
    ...base.aliases,
  ];
  const refused: string[] = [];
  for (const a of settings.adopt.filter((x) => !known.has(x.key))) {
    const name = await nameFromList(req, r, a.id);
    if (name === null) continue;
    if (name.startsWith(groupPrefix) || /admin/i.test(name) || taken.includes(name))
      refused.push(`g:${a.key}`);
    else await recordAdopted(db, a.key, a.id, name, at);
  }
  return refused;
}

export interface TargetRead {
  groups: Record<string, string | null>;
  /** Role and protected groups: `[label, live name, configured name]`. A problem here is global. */
  roles: [string, string | null, string][];
  /** Custom and adopted groups that are renamed or missing: only these targets stop. */
  blocked: string[];
}

/**
 * Reads every managed group's name. Groups are found through the list, so a large member array is never
 * fetched; the by-id read is the fallback for a miss. Role groups are read first: when none answers, the layout is
 * wrong, nothing else is read and no state changes. A custom group missing once is blocked for that probe and
 * marked; only a second miss a health TTL later makes it gone, and a found group is live again.
 */
export async function readTargets(
  db: D1Database,
  r: Routes,
  registry: Registry,
  req: Req,
  now: number,
): Promise<TargetRead> {
  const out: TargetRead = { groups: {}, roles: [], blocked: [] };
  const rows = await listGroupRows(db);
  const bySearch = async (id: string, name: string): Promise<string | null> => {
    for (let page = 1; page <= 5; page++) {
      const res = await req('GET', r.groupSearch(name, page));
      if (res.status === 404) return null;
      if (!ok(res)) throw failure(res);
      const list = items(res.body);
      const hit = list.find((g) => g.id === id);
      if (hit) return hit.name;
      if (list.length < 100) break;
    }
    return null;
  };
  const byId = async (id: string): Promise<string | null> => {
    const res = await req('GET', r.group(id));
    if (res.status === 404) return null;
    if (!ok(res)) throw failure(res);
    const name = str((res.body as { name?: unknown } | null)?.name);
    if (name === null)
      throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group.');
    return name;
  };
  for (const e of registry.entries) {
    const name = (await bySearch(e.id, e.name)) ?? (await byId(e.id));
    out.groups[e.role] ??= name;
    out.roles.push([e.role, name, e.name]);
  }
  if (out.roles.every(([, name]) => name === null)) return out;
  for (const c of registry.custom) {
    const label = `g:${c.key}`;
    const row = rows.find((x) => x.key === c.key);
    const name = (await bySearch(c.id, c.name)) ?? (await byId(c.id));
    out.groups[label] = name;
    if (name !== null) {
      if (row?.missingSince != null) await setMissingSince(db, c.key, null);
      if (name !== c.name) out.blocked.push(label);
      continue;
    }
    out.blocked.push(label);
    if (row?.missingSince == null) await setMissingSince(db, c.key, now);
    else if (now - row.missingSince >= HEALTH_TTL && c.kind === 'custom' && row.createdByBinding)
      await setGroupGone(db, c.key);
  }
  // A group marked gone that is found again under its id is live again.
  for (const row of rows.filter((x) => x.state === 'gone' && x.groupId && x.createdByBinding)) {
    if ((await bySearch(row.groupId as string, row.name)) === row.name)
      await setGroupBack(db, row.key);
  }
  return out;
}
