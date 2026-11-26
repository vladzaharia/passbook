import {
  type IdpRpc,
  type RolePlacement,
  type RoleState,
  WRITABLE_ROLES,
} from '../../src/worker/modules/idp/types.ts';
import type { FakeGroup } from './fake-idp-groups.ts';

/** PassBook's client and SCIM connection in the fake Polaris ID. Tests seed and read it as `idp.setup`. */
export interface FakeSetup {
  client: {
    found: boolean;
    ours: boolean;
    cimd: boolean;
    /** The client's callbacks are not PassBook's: every setup write refuses it. */
    callbacksOurs: boolean;
    restricted: boolean;
    /** Groups the client allows: role names, `platform_admin`, and `other:*` entries PassBook never removes. */
    allowed: Set<string>;
    logo: boolean;
    darkLogo: boolean;
  };
  /** Protected roles: `found` exists in Polaris ID but is not recorded yet, `missing` does not exist. */
  protectedGroups: Record<'platform_admin' | 'users', 'recorded' | 'found' | 'missing'>;
  /** A writable role with no placed group: `adoptable` exists and only PassBook uses it, `in_use` is shared with another app. Absent means it would be created. */
  existing: Partial<Record<(typeof WRITABLE_ROLES)[number], 'adoptable' | 'in_use'>>;
  /** The console alias group (`wallet_org_admins`): when it exists and the client does not allow it, restricting refuses. */
  alias: { exists: boolean };
  /** A recorded group was renamed or deleted in Polaris ID: every setup write refuses. */
  groupDrift: boolean;
  scim: {
    exists: boolean;
    /** The owner pointed the provider at another endpoint. */
    foreign: boolean;
    /** The clear token as Polaris ID returns it on read: only `setupStatus` sees it, and only to hash it. */
    token: string | null;
    lastSyncedAt: number | null;
  };
}

export const newFakeSetup = (): FakeSetup => ({
  client: {
    found: true,
    ours: true,
    cimd: true,
    callbacksOurs: true,
    restricted: false,
    allowed: new Set(),
    logo: false,
    darkLogo: false,
  },
  protectedGroups: { platform_admin: 'recorded', users: 'recorded' },
  existing: {},
  alias: { exists: false },
  groupDrift: false,
  scim: { exists: false, foreign: false, token: null, lastSyncedAt: null },
});

type Methods = Pick<
  IdpRpc,
  | 'setupStatus'
  | 'placeRoleGroups'
  | 'allowClientGroups'
  | 'restrictClient'
  | 'setClientLogo'
  | 'ensureScim'
  | 'syncScim'
>;

export interface SetupEnv {
  setup: FakeSetup;
  groups: Map<string, FakeGroup>;
  now(): number;
  enter(method: string, write?: boolean): void;
  /** Dry for the caller's flag alone: setup is gated by `dryRun` and the freeze, not by the write mode. */
  dry(flag: boolean | undefined, bucket: string): boolean;
  write(): void;
}

const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** Reasons ride after the code, as the binding sends them: `IDP_CLIENT: client_lockout`. */
const refuse = (code: string, reason: string): never => {
  throw new Error(`${code}: ${reason}`);
};

export function setupMethods(env: SetupEnv): Methods {
  const { setup, groups } = env;
  const placed = (): string[] =>
    WRITABLE_ROLES.filter((r) => {
      const g = groups.get(r);
      return g !== undefined && g.state !== 'gone';
    });
  const ALIAS = 'alias:wallet_org_admins';
  const required = (): string[] => [
    ...placed(),
    'platform_admin',
    ...(setup.alias.exists ? [ALIAS] : []),
  ];
  const client = (): FakeSetup['client'] => {
    if (!setup.client.found) return refuse('IDP_CLIENT', 'client_not_found');
    if (!setup.client.ours) return refuse('IDP_CLIENT', 'client_not_ours');
    if (!setup.client.callbacksOurs) return refuse('IDP_CLIENT', 'client_foreign_callbacks');
    return setup.client;
  };
  /** What every setup write checks first: an explicit `dryRun`, then no stale group record. */
  const gate = (ctx: { dryRun?: unknown }): void => {
    if (typeof ctx?.dryRun !== 'boolean')
      refuse('IDP_REFUSED', 'Setup needs dryRun true or false.');
    if (setup.groupDrift)
      refuse(
        'IDP_UNSAFE_CONFIG',
        'Unsafe Polaris ID configuration: group_name_mismatch:platform_admin.',
      );
  };
  const roleStates = (): Record<string, RoleState> => {
    const roles: Record<string, RoleState> = {};
    for (const r of WRITABLE_ROLES) {
      const g = groups.get(r);
      const had = g !== undefined && g.state !== 'gone';
      const ex = setup.existing[r];
      roles[r] = had
        ? 'placed'
        : ex === 'adoptable'
          ? 'adopt'
          : ex === 'in_use'
            ? 'in_use'
            : 'create';
    }
    for (const r of ['platform_admin', 'users'] as const) {
      const p = setup.protectedGroups[r];
      roles[r] = p === 'recorded' ? 'placed' : p === 'found' ? 'adopt' : 'missing';
    }
    return roles;
  };
  const unplaced = (): boolean => Object.values(roleStates()).some((s) => s !== 'placed');

  return {
    async setupStatus(opts = {}) {
      env.enter('setupStatus');
      const c = setup.client;
      const hashes = opts.tokenHashes ?? [];
      const live = setup.scim.token === null ? null : await sha256Hex(setup.scim.token);
      const at = live === null ? -1 : hashes.indexOf(live);
      const roles = roleStates();
      return {
        client: {
          found: c.found,
          cimd: c.cimd,
          ours: c.ours,
          callbacksOurs: c.callbacksOurs,
          restricted: c.restricted,
          missingRoles: placed().filter((r) => !c.allowed.has(r)),
          aliases: [
            {
              name: 'wallet_org_admins',
              exists: setup.alias.exists,
              allowed: setup.alias.exists && c.allowed.has(ALIAS),
            },
          ],
          otherGroups: [...c.allowed].filter((g) => g.startsWith('other:')).length,
          logo: c.logo,
          darkLogo: c.darkLogo,
        },
        roles,
        scim: {
          exists: setup.scim.exists,
          endpointOk: setup.scim.exists && !setup.scim.foreign,
          token: live === null ? null : at === 0 ? 0 : at === 1 ? 1 : 'other',
          lastSyncedAt: setup.scim.lastSyncedAt,
        },
      };
    },
    async placeRoleGroups(ctx) {
      env.enter('placeRoleGroups', true);
      gate(ctx);
      const isDry = env.dry(ctx.dryRun, 'group_write');
      const result: Record<string, RolePlacement> = {};
      for (const [role, state] of Object.entries(roleStates())) {
        const writable = (WRITABLE_ROLES as readonly string[]).includes(role);
        if (state === 'in_use' || state === 'missing') result[role] = state;
        else if (state === 'placed') result[role] = 'already';
        else if (state === 'create') result[role] = 'created';
        else result[role] = writable ? 'adopted' : 'recorded';
        if (isDry || state === 'placed' || state === 'in_use' || state === 'missing') continue;
        env.write();
        if (!writable) setup.protectedGroups[role as 'platform_admin' | 'users'] = 'recorded';
        else {
          delete setup.existing[role as (typeof WRITABLE_ROLES)[number]];
          groups.set(role, {
            kind: 'role',
            name: `passbook_${role}`,
            friendlyName: `passbook_${role}`,
            otherClients: 0,
          });
        }
      }
      return { roles: result, dryRun: isDry };
    },
    async allowClientGroups(ctx) {
      env.enter('allowClientGroups', true);
      gate(ctx);
      if (unplaced()) return refuse('IDP_REFUSED', 'A role group is not placed.');
      const c = client();
      const isDry = env.dry(ctx.dryRun, 'client_write');
      const add = required().filter((g) => !c.allowed.has(g));
      if (!isDry && add.length > 0) {
        env.write();
        for (const g of add) c.allowed.add(g);
      }
      return { result: add.length > 0 ? 'allowed' : 'already', added: add.length, dryRun: isDry };
    },
    async restrictClient(ctx) {
      env.enter('restrictClient', true);
      gate(ctx);
      const c = client();
      if (c.restricted) return { result: 'already', dryRun: env.dry(ctx.dryRun, 'client_write') };
      if (!c.allowed.has('platform_admin') || (setup.alias.exists && !c.allowed.has(ALIAS)))
        return refuse('IDP_CLIENT', 'client_lockout');
      const isDry = env.dry(ctx.dryRun, 'client_write');
      if (!isDry) {
        env.write();
        c.restricted = true;
      }
      return { result: 'restricted', dryRun: isDry };
    },
    async setClientLogo(ctx) {
      env.enter('setClientLogo', true);
      gate(ctx);
      const c = client();
      const isDry = env.dry(ctx.dryRun, 'client_write');
      if (c.logo && c.darkLogo) return { result: 'already', dryRun: isDry };
      if (!c.restricted) return refuse('IDP_CLIENT', 'client_open');
      if (!isDry) {
        env.write();
        c.logo = true;
        c.darkLogo = true;
      }
      return { result: 'set', dryRun: isDry };
    },
    async ensureScim(token, ctx) {
      env.enter('ensureScim', true);
      gate(ctx);
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return refuse('IDP_REFUSED', 'Invalid token.');
      if (!client().restricted) return refuse('IDP_CLIENT', 'client_open');
      if (setup.scim.exists && setup.scim.foreign)
        return refuse('IDP_SCIM_FOREIGN', 'scim_endpoint_foreign');
      const isDry = env.dry(ctx.dryRun, 'scim_write');
      if (setup.scim.exists && setup.scim.token === token)
        return { result: 'already', dryRun: isDry };
      const result = setup.scim.exists ? 'rotated' : 'created';
      if (!isDry) {
        env.write();
        setup.scim.exists = true;
        setup.scim.token = token;
      }
      return { result, dryRun: isDry };
    },
    async syncScim(ctx) {
      env.enter('syncScim', true);
      gate(ctx);
      if (!client().restricted) return refuse('IDP_CLIENT', 'client_open');
      if (!setup.scim.exists) return refuse('IDP_NOT_FOUND', 'no_scim_provider');
      if (setup.scim.foreign) return refuse('IDP_SCIM_FOREIGN', 'scim_endpoint_foreign');
      const isDry = env.dry(ctx.dryRun, 'scim_sync');
      if (!isDry) {
        env.write();
        setup.scim.lastSyncedAt = env.now();
      }
      return { result: 'synced', dryRun: isDry };
    },
  };
}
