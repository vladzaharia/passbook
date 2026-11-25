import { claim } from './breaker.ts';
import { ctxMeta, meta, noteCall } from './ledger.ts';
import { withLock } from './lock.ts';
import { failure, ok, type Req } from './pocket-http.ts';
import {
  assertCtx,
  assertFriendlyName,
  assertGroupKey,
  assertTarget,
  refuse,
  sameSet,
} from './policy.ts';
import { ID } from './registry.ts';
import type { Shared } from './shared.ts';
import {
  insertIntent,
  listGroupRows,
  setGroupDeleted,
  setGroupDeleting,
  setGroupLive,
} from './store.ts';
import {
  type Bucket,
  IdpError,
  type IdpRpc,
  type ManagedGroup,
  type WritableRole,
} from './types.ts';

type GroupAdminApi = Pick<
  IdpRpc,
  'groups' | 'createGroup' | 'ensureRoleGroup' | 'updateGroup' | 'deleteGroup'
>;

const unexpected = () => new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group.');
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

interface GroupDto {
  id: string;
  name: string;
  friendlyName: string | null;
  users: unknown[];
  clients: string[];
  claimKeys: string[];
  ldap: boolean;
}

/** A group DTO, strictly: a missing `users`, `allowedOidcClients` or `customClaims` fails the call, never reads as empty. */
function parseGroup(body: unknown): GroupDto {
  const g = body as Record<string, unknown> | null;
  const clients = g?.allowedOidcClients;
  const claims = g?.customClaims;
  if (
    !g ||
    typeof g.id !== 'string' ||
    !ID.test(g.id) ||
    typeof g.name !== 'string' ||
    !Array.isArray(g.users) ||
    !Array.isArray(clients) ||
    !Array.isArray(claims)
  )
    throw unexpected();
  return {
    id: g.id,
    name: g.name,
    friendlyName: str(g.friendlyName),
    users: g.users,
    clients: clients.map((c) => str((c as { id?: unknown })?.id) ?? ''),
    claimKeys: claims.map((c) => str((c as { key?: unknown })?.key) ?? ''),
    ldap: typeof g.ldapId === 'string' && g.ldapId !== '',
  };
}

/** Group lifecycle: create, ensure a configured role group, rename the friendly name, delete an empty PassBook-made group. */
export function groupAdminApi(s: Shared): GroupAdminApi {
  const { db, deps, env, r, call, gate } = s;
  const bucketFor = (dryRun: boolean): Bucket => (dryRun ? 'preview' : 'group_write');

  /** An exact-name search: the existing group, if any. `IDP_CONFLICT` for a taken name, never adopted. */
  async function nameTaken(req: Req, name: string): Promise<boolean> {
    const res = await req('GET', r.groupSearch(name));
    if (!ok(res)) throw failure(res);
    const data = (res.body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw unexpected();
    return data.some((g) => (g as { name?: unknown })?.name === name);
  }

  async function post(req: Req, name: string, friendlyName: string): Promise<GroupDto> {
    const res = await req('POST', r.groups, { name, friendlyName });
    if (!ok(res)) throw failure(res);
    const created = parseGroup(res.body);
    const back = await req('GET', r.group(created.id));
    if (!ok(back)) throw failure(back);
    const g = parseGroup(back.body);
    if (g.id !== created.id || g.name !== name || g.friendlyName !== friendlyName)
      throw new IdpError('IDP_DRIFT', 'The group did not come back as created.');
    return g;
  }

  return {
    async groups() {
      const { registry } = await gate.readable();
      const rows = await listGroupRows(db);
      const list = [
        ...registry.writable.map((e) => ({
          key: e.role as string,
          kind: 'role' as const,
          id: e.id,
          name: e.name,
        })),
        ...registry.custom.map((c) => ({ key: c.key, kind: c.kind, id: c.id, name: c.name })),
      ];
      const m = meta('groups');
      const buckets = list.map(() => 'snapshot_group' as const);
      if (!buckets.length) return [];
      return call.ledgered(buckets, m, async (req) => {
        const out: ManagedGroup[] = [];
        for (const e of list) {
          const res = await req('GET', r.group(e.id));
          const flags: string[] = [];
          if (res.status === 404) {
            out.push({
              key: e.key,
              kind: e.kind,
              name: e.name,
              friendlyName: null,
              members: null,
              claims: [],
              otherClients: null,
              flags: ['group_not_found'],
            });
            continue;
          }
          if (!ok(res)) throw failure(res);
          const g = parseGroup(res.body);
          if (g.name !== e.name) flags.push('group_name_mismatch');
          out.push({
            key: e.key,
            kind: e.kind,
            name: g.name,
            friendlyName: g.friendlyName,
            members: g.users.length,
            claims: g.claimKeys,
            otherClients: g.clients.filter((c) => c !== env.PASSBOOK_CLIENT_ID).length,
            flags,
          });
        }
        void rows;
        return out;
      });
    },

    async createGroup(key, friendlyName, ctx) {
      const c = await call.guard(meta('createGroup'), () => assertCtx(ctx));
      const m0 = ctxMeta('createGroup', c);
      const { k, friendly } = await call.guard(m0, () => ({
        k: assertGroupKey(key),
        friendly: assertFriendlyName(friendlyName),
      }));
      const m = { ...m0, target: `g:${k}`, delta: 'create_group' };
      const { registry, settings } = await gate.requireWrite(m);
      const name = `${settings.customPrefix}${k}`;
      const rows = await listGroupRows(db);
      if (rows.some((x) => x.key === k) || settings.adopt.some((a) => a.key === k))
        await call.guard(m, () => refuse('This group key was used.'));
      const used = rows.filter(
        (x) =>
          x.kind !== 'role' &&
          (x.state === 'pending' || x.state === 'live' || x.state === 'deleting'),
      ).length;
      if (used + settings.adopt.length >= settings.customLimit)
        await call.guard(m, () => refuse('Group limit reached.'));
      void registry;
      return call.ledgered(bucketFor(c.dryRun), m, (req) =>
        withLock(db, `g:${k}`, deps.now, async () => {
          if (await nameTaken(req, name))
            throw new IdpError('IDP_CONFLICT', 'A group with this name exists.');
          if (s.dry(c.dryRun)) {
            await noteCall(db, 'dry_run', m, deps.now(), 'dry_run');
            return { dryRun: true as const };
          }
          await insertIntent(db, { key: k, kind: 'custom', name, ref: c.ref, at: deps.now() });
          const g = await post(req, name, friendly);
          await setGroupLive(db, k, g.id);
          return { key: k };
        }),
      );
    },

    async ensureRoleGroup(role, ctx) {
      const c = await call.guard(meta('ensureRoleGroup'), () => assertCtx(ctx));
      const m0 = ctxMeta('ensureRoleGroup', c);
      const target = await call.guard(m0, () => {
        const t = assertTarget(role);
        if (t.startsWith('g:')) refuse('Invalid role.');
        return t as WritableRole;
      });
      const m = { ...m0, target: null, role: target, delta: 'ensure_group' };
      const { registry } = await gate.requireWrite(m);
      const want = registry.unplaced.find((u) => u.role === target);
      if (!want) await call.guard(m, () => refuse('This role group already has an id.'));
      const u = want as NonNullable<typeof want>;
      return call.ledgered(bucketFor(c.dryRun), m, (req) =>
        withLock(db, `role:${target}`, deps.now, async () => {
          if (await nameTaken(req, u.name))
            throw new IdpError(
              'IDP_CONFLICT',
              'A group with this name exists. Add its id to GROUPS.',
            );
          if (s.dry(c.dryRun)) {
            await noteCall(db, 'dry_run', m, deps.now(), 'dry_run');
            return { dryRun: true as const };
          }
          await insertIntent(db, {
            key: target,
            kind: 'role',
            name: u.name,
            ref: c.ref,
            at: deps.now(),
          });
          const g = await post(req, u.name, u.friendlyName);
          // The PassBook client must allow the group, or its members could not sign in: union, never replace.
          const want = [...new Set([...g.clients, env.PASSBOOK_CLIENT_ID])];
          const put = await req('PUT', r.groupClients(g.id), { oidcClientIds: want });
          if (!ok(put)) throw failure(put);
          const back = await req('GET', r.group(g.id));
          if (!ok(back)) throw failure(back);
          if (!sameSet(parseGroup(back.body).clients, want))
            throw new IdpError('IDP_DRIFT', 'The group clients did not come back as written.');
          await setGroupLive(db, target, g.id);
          return { key: target };
        }),
      );
    },

    async updateGroup(target, change, ctx) {
      const c = await call.guard(meta('updateGroup'), () => assertCtx(ctx));
      const m0 = ctxMeta('updateGroup', c);
      const { t, friendly } = await call.guard(m0, () => ({
        t: assertTarget(target),
        friendly: assertFriendlyName((change as { friendlyName?: unknown } | null)?.friendlyName),
      }));
      const m = { ...m0, target: t, delta: 'rename_group' };
      const { registry } = await gate.requireWrite(m);
      const id = await call.guard(m, () => registry.targetId(t) ?? refuse('Group is not managed.'));
      const expected = t.startsWith('g:')
        ? registry.custom.find((x) => `g:${x.key}` === t)?.name
        : registry.entry(t as WritableRole)?.name;
      return call.ledgered(bucketFor(c.dryRun), m, (req) =>
        withLock(db, t, deps.now, async () => {
          const res = await req('GET', r.group(id));
          if (!ok(res)) throw failure(res);
          const g = parseGroup(res.body);
          // The name is what every app keys on: it is sent back as read and never changed here.
          if (g.name !== expected)
            throw new IdpError('IDP_CONFLICT', 'This group was renamed in Polaris ID.');
          if (s.dry(c.dryRun)) {
            await noteCall(db, 'dry_run', m, deps.now(), 'dry_run');
            return { dryRun: true as const };
          }
          const put = await req('PUT', r.group(id), { name: g.name, friendlyName: friendly });
          if (!ok(put)) throw failure(put);
          const back = await req('GET', r.group(id));
          if (!ok(back)) throw failure(back);
          const after = parseGroup(back.body);
          if (after.name !== g.name || after.friendlyName !== friendly)
            throw new IdpError('IDP_DRIFT', 'The group did not come back as written.');
          return { target: t };
        }),
      );
    },

    async deleteGroup(key, ctx) {
      const c = await call.guard(meta('deleteGroup'), () => assertCtx(ctx));
      const m0 = ctxMeta('deleteGroup', c);
      const k = await call.guard(m0, () => assertGroupKey(key));
      const m = { ...m0, target: `g:${k}`, delta: 'delete_group' };
      await gate.requireWrite(m);
      const row = (await listGroupRows(db)).find((x) => x.key === k);
      // Only a custom group the binding made, and only once it is live. Role and adopted groups are never deleted.
      if (row?.kind !== 'custom' || !row.createdByBinding || row.state !== 'live' || !row.groupId)
        await call.guard(m, () => refuse('This group cannot be deleted here.'));
      const live = row as NonNullable<typeof row>;
      const id = live.groupId as string;
      return call.ledgered(bucketFor(c.dryRun), m, (req) =>
        withLock(db, `g:${k}`, deps.now, async () => {
          const res = await req('GET', r.group(id));
          if (!ok(res)) throw failure(res);
          const g = parseGroup(res.body);
          if (g.name !== live.name)
            throw new IdpError('IDP_CONFLICT', 'This group was renamed in Polaris ID.');
          if (g.users.length || g.clients.length || g.ldap)
            throw new IdpError('IDP_IN_USE', 'This group still has members or apps.');
          await claim(db, m, { deletes: 1 }, deps.now());
          if (s.dry(c.dryRun)) {
            await noteCall(db, 'dry_run', m, deps.now(), 'dry_run');
            return { dryRun: true as const };
          }
          await setGroupDeleting(db, k);
          const del = await req('DELETE', r.group(id));
          if (del.status !== 404 && !ok(del)) throw failure(del);
          const gone = await req('GET', r.group(id));
          if (gone.status !== 404)
            throw new IdpError('IDP_DRIFT', 'The group still exists after the delete.');
          await setGroupDeleted(db, k, deps.now());
          return { key: k };
        }),
      );
    },
  };
}
