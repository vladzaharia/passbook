import { keyKind } from './claims.ts';
import { assertNotFrozen } from './freeze.ts';
import { createRoleGroup } from './group-create.ts';
import { type GroupDto, parseGroup } from './group-dto.ts';
import { exactHit } from './group-find.ts';
import { failure, ok, type Req } from './pocket-http.ts';
import type { Registry } from './registry.ts';
import { setupRunner } from './setup-shell.ts';
import type { PlaceResult, RolePlacement, RoleState, SetupRpc } from './setup-types.ts';
import type { Shared } from './shared.ts';
import { invalidateHealth } from './store.ts';
import { recordRoleGroup } from './store-groups.ts';
import { type Role, WRITABLE_ROLES, type WritableRole } from './types.ts';

/** A writable role's existing group may be adopted only when no other app trusts it. */
export function adoptable(g: GroupDto, clientId: string): boolean {
  return (
    g.clients.every((c) => c === clientId) &&
    g.claimKeys.every((k) => keyKind(k, []) === 'ns') &&
    !g.ldap
  );
}

export interface Plan {
  roles: Record<string, RoleState>;
  /** Existing groups to record: protected ones, and adopted writable ones. */
  record: { role: Role; id: string; name: string; protected: boolean }[];
  create: { role: WritableRole; name: string; friendlyName: string }[];
}

const RANK: RoleState[] = ['configured', 'placed', 'adopt', 'create', 'in_use', 'missing'];

/** What `placeRoleGroups` would do for every configured role. Reads only. */
export async function planRoles(s: Shared, req: Req, registry: Registry): Promise<Plan> {
  const base = s.gate.peek();
  const plan: Plan = { roles: {}, record: [], create: [] };
  const set = (role: string, state: RoleState) => {
    const had = plan.roles[role];
    if (had === undefined || RANK.indexOf(state) < RANK.indexOf(had)) plan.roles[role] = state;
  };
  for (const e of registry.entries)
    set(e.role, base?.entries.some((b) => b.role === e.role) ? 'configured' : 'placed');
  for (const u of registry.unplaced) {
    const id = await exactHit(s.r, req, u.name);
    if (id === null) {
      set(u.role, 'create');
      plan.create.push({ role: u.role, name: u.name, friendlyName: u.friendlyName });
      continue;
    }
    const res = await req('GET', s.r.group(id));
    if (!ok(res)) throw failure(res);
    if (adoptable(parseGroup(res.body), s.env.PASSBOOK_CLIENT_ID)) {
      set(u.role, 'adopt');
      plan.record.push({ role: u.role, id, name: u.name, protected: false });
    } else set(u.role, 'in_use');
  }
  for (const u of registry.unplacedProtected) {
    const id = await exactHit(s.r, req, u.name);
    // A group the registry already has under another role is never recorded twice.
    if (id === null || registry.allIds.includes(id)) {
      set(u.role, id === null ? 'missing' : 'placed');
      continue;
    }
    set(u.role, 'adopt');
    plan.record.push({ role: u.role, id, name: u.name, protected: true });
  }
  return plan;
}

const PLACEMENT: Record<RoleState, RolePlacement> = {
  configured: 'already',
  placed: 'already',
  adopt: 'recorded',
  create: 'created',
  in_use: 'in_use',
  missing: 'missing',
};

/**
 * Turns configured group names into the ids the binding protects (platform admins) or manages (console,
 * developer). Names come from deploy config only. Protected groups are found, never created; a writable
 * one is created, or adopted only when nothing else depends on it. A record never changes after.
 */
export function setupGroupsApi(s: Shared): Pick<SetupRpc, 'placeRoleGroups'> {
  const { db, deps } = s;
  const run = setupRunner(s);
  return {
    placeRoleGroups: (ctx) =>
      run(
        { method: 'placeRoleGroups', delta: 'place', lease: 'setup:groups', bucket: 'group_write' },
        ctx,
        async ({ req, dry, registry, note, ref, m }): Promise<PlaceResult> => {
          const plan = await planRoles(s, req, registry);
          const roles: Record<string, RolePlacement> = {};
          for (const [role, state] of Object.entries(plan.roles)) {
            roles[role] =
              state === 'adopt' && (WRITABLE_ROLES as readonly string[]).includes(role)
                ? 'adopted'
                : PLACEMENT[state];
          }
          if (!plan.record.length && !plan.create.length) return { roles, dryRun: dry };
          if (dry) {
            await note();
            return { roles, dryRun: true };
          }
          // The records below are D1 writes the request-level freeze check does not see.
          await assertNotFrozen(db, m, deps.now());
          for (const g of plan.record)
            await recordRoleGroup(db, {
              key: g.protected ? `${g.role}:${g.name}` : g.role,
              groupId: g.id,
              name: g.name,
              ref,
              at: deps.now(),
            });
          for (const g of plan.create) await createRoleGroup(s, req, g.role, g, ref);
          await invalidateHealth(db);
          return { roles, dryRun: false };
        },
      ),
  };
}
