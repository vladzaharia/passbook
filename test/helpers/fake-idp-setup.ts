import { type IdpRpc, type RoleState, WRITABLE_ROLES } from '../../src/worker/modules/idp/types.ts';
import type { FakeGroup } from './fake-idp-groups.ts';

/** PassBook's client and SCIM connection in the fake Polaris ID. Tests seed and read it as `idp.setup`. */
export interface FakeSetup {
  client: {
    found: boolean;
    ours: boolean;
    cimd: boolean;
    restricted: boolean;
    /** Groups the client allows: role names, `platform_admin`, and `other:*` entries PassBook never removes. */
    allowed: Set<string>;
    logo: boolean;
    darkLogo: boolean;
  };
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
    restricted: false,
    allowed: new Set(),
    logo: false,
    darkLogo: false,
  },
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
  const required = (): string[] => [...placed(), 'platform_admin'];
  const client = (): FakeSetup['client'] => {
    if (!setup.client.found) return refuse('IDP_CLIENT', 'client_not_found');
    if (!setup.client.ours) return refuse('IDP_CLIENT', 'client_not_ours');
    return setup.client;
  };

  return {
    async setupStatus(opts = {}) {
      env.enter('setupStatus');
      const c = setup.client;
      const hashes = opts.tokenHashes ?? [];
      const live = setup.scim.token === null ? null : await sha256Hex(setup.scim.token);
      const at = live === null ? -1 : hashes.indexOf(live);
      const roles: Record<string, RoleState> = {};
      for (const r of WRITABLE_ROLES) {
        const g = groups.get(r);
        roles[r] = g === undefined || g.state === 'gone' ? 'create' : 'placed';
      }
      return {
        client: {
          found: c.found,
          cimd: c.cimd,
          ours: c.ours,
          restricted: c.restricted,
          missingRoles: placed().filter((r) => !c.allowed.has(r)),
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
      const isDry = env.dry(ctx.dryRun, 'group_write');
      const result: Record<string, 'already' | 'created'> = {};
      for (const role of WRITABLE_ROLES) {
        const g = groups.get(role);
        if (g && g.state !== 'gone') {
          result[role] = 'already';
          continue;
        }
        result[role] = 'created';
        if (isDry) continue;
        env.write();
        groups.set(role, {
          kind: 'role',
          name: `passbook_${role}`,
          friendlyName: `passbook_${role}`,
          otherClients: 0,
        });
      }
      return { roles: result, dryRun: isDry };
    },
    async allowClientGroups(ctx) {
      env.enter('allowClientGroups', true);
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
      const c = client();
      if (!c.restricted && !c.allowed.has('platform_admin'))
        return refuse('IDP_CLIENT', 'client_lockout');
      const isDry = env.dry(ctx.dryRun, 'client_write');
      if (c.restricted) return { result: 'already', dryRun: isDry };
      if (!isDry) {
        env.write();
        c.restricted = true;
      }
      return { result: 'restricted', dryRun: isDry };
    },
    async setClientLogo(ctx) {
      env.enter('setClientLogo', true);
      const c = client();
      const isDry = env.dry(ctx.dryRun, 'client_write');
      if (c.logo && c.darkLogo) return { result: 'already', dryRun: isDry };
      if (!isDry) {
        env.write();
        c.logo = true;
        c.darkLogo = true;
      }
      return { result: 'set', dryRun: isDry };
    },
    async ensureScim(token, ctx) {
      env.enter('ensureScim', true);
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
