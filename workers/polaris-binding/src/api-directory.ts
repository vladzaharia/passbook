import { writeFreeze } from './freeze.ts';
import { ctxMeta, meta, noteCall } from './ledger.ts';
import { failure, ok } from './pocket-http.ts';
import { assertCtx, assertEmail, assertSince, ID } from './policy.ts';
import type { Shared } from './shared.ts';
import {
  clearDisabledMarks,
  endedSince,
  endGrants,
  grantsOfRole,
  liveGrantSubjects,
  noteExternal,
} from './store.ts';
import {
  IdpError,
  type IdpRpc,
  type Role,
  type Snapshot,
  type SnapshotMember,
  WRITABLE_ROLES,
  type WritableRole,
} from './types.ts';

type DirectoryApi = Pick<IdpRpc, 'findByVerifiedEmail' | 'snapshot' | 'freeze'>;
const SEARCH_PAGES = 3;

interface UserRow {
  id?: unknown;
  email?: unknown;
  emailVerified?: unknown;
  disabled?: unknown;
  isAdmin?: unknown;
  userGroups?: { id?: unknown }[];
}

/** Finding an account, reading every registry group, and the emergency pause. */
export function directoryApi(s: Shared): DirectoryApi {
  const { db, deps, r, call, gate } = s;

  return {
    async findByVerifiedEmail(email, ctx) {
      const c = await call.guard(meta('findByVerifiedEmail'), () => assertCtx(ctx));
      const m = ctxMeta('findByVerifiedEmail', c);
      const want = await call.guard(m, () => assertEmail(email));
      const registry = gate.readable();
      // The address is in the search url and the comparison only: never in the ledger, a log or a result.
      return call.ledgered('findByVerifiedEmail', m, async (req) => {
        const hits: string[] = [];
        let pages = 1;
        for (let page = 1; page <= SEARCH_PAGES; page++) {
          const res = await req('GET', r.users(want, page));
          if (!ok(res)) throw failure(res);
          const body = res.body as {
            data?: UserRow[];
            pagination?: { totalPages?: unknown };
          } | null;
          // A malformed list or entry fails the search: skipping it could hide a second holder of the address.
          if (!Array.isArray(body?.data))
            throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected user list.');
          for (const u of body.data) {
            if (!u || typeof u !== 'object' || typeof u.email !== 'string')
              throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected user list.');
            if (u.email.toLowerCase() !== want) continue;
            const groups = (Array.isArray(u.userGroups) ? u.userGroups : []).map((g) => g?.id);
            // Unknown flags are not "verified, enabled, not an admin".
            const eligible =
              typeof u.id === 'string' &&
              ID.test(u.id) &&
              u.emailVerified === true &&
              u.disabled === false &&
              u.isAdmin === false &&
              Array.isArray(u.userGroups) &&
              groups.every((g) => typeof g === 'string' && !registry.adminIds.includes(g));
            hits.push(eligible ? (u.id as string) : '');
          }
          const total = body?.pagination?.totalPages;
          if (typeof total === 'number') pages = total;
          if (typeof total !== 'number' || page >= total) break;
        }
        const [only] = hits;
        // More pages than were read: uniqueness cannot be shown, so there is no match.
        if (pages > SEARCH_PAGES) return null;
        // Exactly one account holds the address, and it is eligible.
        return hits.length === 1 && only ? { subject: only } : null;
      });
    },

    async snapshot(ctx) {
      const c = await call.guard(meta('snapshot'), () => assertCtx(ctx));
      const m = ctxMeta('snapshot', c);
      const since = await call.guard(m, () => assertSince((ctx as { since?: unknown }).since));
      const registry = gate.readable();
      const started = deps.now();
      const dry = s.dry(c.dryRun);
      return call.ledgered(c.dryRun ? 'preview' : 'snapshot', m, async (req) => {
        const roles: Snapshot['roles'] = {};
        const live = new Map<Role, Set<string>>();
        for (const e of registry.entries) {
          // The user group can hold everyone: its members are not needed, so it is not read.
          if (e.role === 'users') continue;
          const res = await req('GET', r.group(e.id));
          if (!ok(res)) throw failure(res);
          const g = res.body as { name?: unknown; users?: UserRow[] } | null;
          if (typeof g?.name !== 'string' || !Array.isArray(g.users))
            throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group.');
          const members: SnapshotMember[] = g.users.map((u) => {
            if (typeof u?.id !== 'string' || !ID.test(u.id))
              throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group.');
            return {
              subject: u.id,
              // Unknown flags read as the dangerous answer.
              disabled: u.disabled !== false,
              isAdmin: u.isAdmin !== false,
              grant: false,
            };
          });
          live.set(e.role, new Set(members.map((x) => x.subject)));
          roles[e.role] = {
            name: g.name,
            members: [...(roles[e.role]?.members ?? []), ...members],
          };
        }
        // Every read answered: only now may this Worker's own tables change, and not in a dry run.
        const ended: Snapshot['ended'] = [];
        const enabled: string[] = [];
        for (const role of WRITABLE_ROLES) {
          const members = live.get(role);
          const entry = roles[role];
          if (!members || !entry) continue;
          const everyGrant = new Set(await liveGrantSubjects(db, role));
          // Pending grants and grants confirmed after this read began are not for it to end.
          for (const sub of await grantsOfRole(db, role, started))
            if (!members.has(sub)) {
              if (!dry) await endGrants(db, sub, [role], 'idp_removed', deps.now());
              ended.push({ subject: sub, role: role as WritableRole });
            }
          for (const member of entry.members) {
            member.grant = everyGrant.has(member.subject);
            if (!member.disabled) enabled.push(member.subject);
            if (!dry && !member.grant && !member.isAdmin)
              await noteExternal(db, member.subject, deps.now());
          }
        }
        if (!dry) await clearDisabledMarks(db, enabled);
        const again = dry ? [] : await endedSince(db, since ?? started);
        const key = (x: { subject: string; role: string }) => `${x.subject}:${x.role}`;
        const seen = new Set(ended.map(key));
        return { roles, ended: [...ended, ...again.filter((x) => !seen.has(key(x)))] };
      });
    },

    async freeze(reason, ctx) {
      const c = await call.guard(meta('freeze'), () => assertCtx({ ...ctx, reason }));
      const m = ctxMeta('freeze', c, { delta: 'freeze' });
      const out = await writeFreeze(db, c.reason, c.actor, deps.now());
      await noteCall(db, 'end', m, deps.now(), out);
      return out;
    },
  };
}
