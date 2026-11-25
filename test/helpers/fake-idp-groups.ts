import type {
  ClaimChange,
  ClaimOwner,
  ClaimValue,
  IdpRpc,
  ManagedGroup,
  Target,
  WritableRole,
} from '../../src/worker/modules/idp/types.ts';

export interface FakeAccount {
  class: 'created' | 'linked' | 'external';
  /** Role names and `g:<key>` targets held. */
  roles: Set<string>;
  /** Targets PassBook added (a live grant); removing any other needs `override`. */
  grants: Set<string>;
  /** Grants recorded but not yet read back: in `grants`, never in `confirmedGrants`. */
  pending: Set<string>;
  disabled: boolean;
  isAdmin: boolean;
  email?: string;
  emailVerified: boolean;
  /** Claims other apps set: kept byte for byte, counted, never shown. */
  otherClaims?: Record<string, string>;
  claims?: Record<string, ClaimValue>;
}

export interface FakeGroup {
  kind: 'role' | 'custom' | 'adopted';
  /** Polaris ID name; the key is `passbook_g_`-prefixed for custom groups. */
  name: string;
  friendlyName: string;
  /** `gone`: deleted in Polaris ID by the owner; `deleting`: a delete stopped half way. */
  state?: 'live' | 'gone' | 'deleting';
  /** The owner renamed it in Polaris ID. */
  renamed?: boolean;
  /** Allowed clients other than PassBook's. */
  otherClients: number;
  otherClaims?: Record<string, string>;
  claims?: Record<string, ClaimValue>;
}

/** Pocket ID's reserved claim names (F8). */
export const RESERVED_CLAIMS = new Set(
  'given_name family_name name email email_verified preferred_username display_name groups type sub iss aud exp iat auth_time nonce acr amr azp client_id nbf jti'.split(
    ' ',
  ),
);
export const GROUP_KEY = /^[a-z][a-z0-9_]{1,39}$/;
export const CUSTOM_PREFIX = 'passbook_g_';
const CLAIM_KEY = /^passbook_[a-z0-9_]{1,48}$/;
const ROLES = ['console', 'developer', 'support'];

export interface GroupEnv {
  accounts: Map<string, FakeAccount>;
  groups: Map<string, FakeGroup>;
  claimKeys: string[];
  customLimit: number;
  enter(method: string, write?: boolean): void;
  /** True for a dry run. Charges `bucket` (`preview` when dry); over its limit answers `IDP_BUDGET`. */
  dry(flag: boolean | undefined, bucket: string): boolean;
  write(): void;
  refuse(code: string): never;
  account(subject: string): FakeAccount;
  protect(subject: string, a: FakeAccount): void;
  lease(key: string): void;
  /** Counts a live removal toward the breaker; over its limit answers `IDP_BREAKER`. */
  removal(): void;
}

type Methods = Pick<
  IdpRpc,
  | 'groups'
  | 'createGroup'
  | 'ensureRoleGroup'
  | 'updateGroup'
  | 'deleteGroup'
  | 'claims'
  | 'setClaims'
>;

const sizeOf = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;
const depthOf = (v: unknown): number =>
  v !== null && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v).map(depthOf)) : 0;

export function groupMethods(env: GroupEnv): Methods & {
  /** Throws `IDP_REFUSED` for a target the binding does not manage. */
  assertTargets(targets: readonly Target[], adds?: readonly Target[]): void;
  membersOf(target: string): number;
  /** `g:<key>` targets health reports as blocked. */
  blockedTargets(): string[];
} {
  const { accounts, groups, refuse } = env;
  const membersOf = (target: string): number =>
    [...accounts.values()].filter((a) => a.roles.has(target)).length;
  const keyOf = (target: string): string => target.replace(/^g:/, '');
  const view = (key: string, g: FakeGroup): ManagedGroup => ({
    key,
    kind: g.kind,
    name: g.name,
    friendlyName: g.friendlyName,
    members: membersOf(g.kind === 'role' ? key : `g:${key}`),
    claims: Object.keys(g.claims ?? {}).filter(
      (k) => CLAIM_KEY.test(k) || env.claimKeys.includes(k),
    ),
    otherClients: g.otherClients,
    flags: [],
  });
  /** Health marks a renamed or gone custom or adopted group blocked: its target alone stops. */
  const blocked = (g: FakeGroup): boolean =>
    g.kind !== 'role' && (g.state === 'gone' || !!g.renamed);
  const managed = (key: string): FakeGroup => {
    const g = groups.get(key);
    if (!g || blocked(g)) return refuse('IDP_REFUSED');
    return g;
  };

  /** `passbook_*` for anyone; listed keys only on created or linked accounts, never on groups. */
  const claimKeyOk = (key: string, listedOk: boolean): boolean =>
    !RESERVED_CLAIMS.has(key) &&
    key !== 'picture' &&
    (CLAIM_KEY.test(key) || (listedOk && env.claimKeys.includes(key)));

  const holderOf = (
    owner: ClaimOwner,
  ): {
    claims?: Record<string, ClaimValue>;
    otherClaims?: Record<string, string>;
    listedOk: boolean;
    set(c: Record<string, ClaimValue>): void;
  } => {
    if ('subject' in owner) {
      const a = env.account(owner.subject);
      env.protect(owner.subject, a);
      return {
        claims: a.claims,
        otherClaims: a.otherClaims,
        listedOk: a.class !== 'external',
        set: (c) => {
          a.claims = c;
        },
      };
    }
    const g = groups.get(keyOf(owner.group));
    if (!g || blocked(g) || (g.kind === 'role' && !ROLES.includes(keyOf(owner.group))))
      return refuse('IDP_REFUSED');
    return {
      claims: g.claims,
      otherClaims: g.otherClaims,
      listedOk: false,
      set: (c) => {
        g.claims = c;
      },
    };
  };

  return {
    membersOf,
    blockedTargets: () => [...groups].filter(([, g]) => blocked(g)).map(([k]) => `g:${k}`),
    assertTargets(targets, adds = []) {
      if (targets.length > 10) refuse('IDP_REFUSED');
      for (const t of targets) {
        if (t.startsWith('g:')) {
          const g = groups.get(keyOf(t));
          if (!g || blocked(g) || (g.state === 'deleting' && adds.includes(t)))
            refuse('IDP_REFUSED');
        } else if (!ROLES.includes(t)) refuse('IDP_REFUSED');
      }
    },
    async groups() {
      env.enter('groups');
      return [...groups].map(([key, g]) => view(key, g));
    },
    async createGroup(key, friendlyName, ctx) {
      env.enter('createGroup', true);
      if (!GROUP_KEY.test(key) || ROLES.includes(key)) refuse('IDP_REFUSED');
      if (friendlyName.length < 2 || friendlyName.length > 50) refuse('IDP_REFUSED');
      const custom = [...groups.values()].filter((g) => g.kind !== 'role').length;
      if (custom >= env.customLimit) refuse('IDP_REFUSED');
      const name = `${CUSTOM_PREFIX}${key}`;
      if ([...groups.values()].some((g) => g.name === name)) refuse('IDP_CONFLICT');
      const g: FakeGroup = { kind: 'custom', name, friendlyName, otherClients: 0 };
      if (env.dry(ctx.dryRun, 'group_write')) return { dryRun: true };
      env.write();
      groups.set(key, g);
      return { key };
    },
    async ensureRoleGroup(role: WritableRole, ctx) {
      env.enter('ensureRoleGroup', true);
      env.lease(`role:${role}`);
      if (!ROLES.includes(role) || groups.has(role)) refuse('IDP_REFUSED');
      const name = `passbook_${role}`;
      if ([...groups.values()].some((g) => g.name === name)) refuse('IDP_CONFLICT');
      if (env.dry(ctx.dryRun, 'group_write')) return { dryRun: true };
      env.write();
      const g: FakeGroup = { kind: 'role', name, friendlyName: name, otherClients: 0 };
      groups.set(role, g);
      return { key: role };
    },
    async updateGroup(target, patch, ctx) {
      env.enter('updateGroup', true);
      env.lease(target.startsWith('g:') ? target : `role:${target}`);
      const g = managed(keyOf(target));
      if (patch.friendlyName.length < 2 || patch.friendlyName.length > 50) refuse('IDP_REFUSED');
      if (env.dry(ctx.dryRun, 'group_write')) return { dryRun: true };
      env.write();
      g.friendlyName = patch.friendlyName;
      return { target };
    },
    async deleteGroup(key, ctx) {
      env.enter('deleteGroup', true);
      env.lease(`g:${key}`);
      const g = groups.get(key);
      if (!g) return refuse('IDP_NOT_FOUND');
      if (g.kind !== 'custom') refuse('IDP_REFUSED');
      if (blocked(g)) refuse('IDP_REFUSED');
      if (membersOf(`g:${key}`) > 0 || g.otherClients > 0) {
        g.state = 'live'; // a refused delete puts a `deleting` group back
        refuse('IDP_IN_USE');
      }
      if (env.dry(ctx.dryRun, 'group_write')) return { dryRun: true };
      env.write();
      env.removal();
      groups.delete(key);
      return { key };
    },
    async claims(owner) {
      env.enter('claims');
      const h = holderOf(owner);
      return { claims: { ...h.claims }, otherKeys: Object.keys(h.otherClaims ?? {}).length };
    },
    async setClaims(owner, changes, ctx) {
      env.enter('setClaims', true);
      const h = holderOf(owner);
      env.lease(
        'subject' in owner
          ? `s:${owner.subject}`
          : owner.group.startsWith('g:')
            ? owner.group
            : `role:${owner.group}`,
      );
      const entries = Object.entries(changes);
      if (entries.length > 20) refuse('IDP_REFUSED');
      const next = { ...h.claims };
      const result = { set: [] as string[], removed: [] as string[], dryRun: false };
      for (const [key, change] of entries as [string, ClaimChange][]) {
        if (!claimKeyOk(key, h.listedOk)) refuse('IDP_REFUSED');
        if (change === null) {
          delete next[key];
          result.removed.push(key);
        } else {
          if (sizeOf(change.value) > 2048 || depthOf(change.value) > 5) refuse('IDP_REFUSED');
          next[key] = change;
          result.set.push(key);
        }
      }
      if (Object.keys(next).length > 20 || sizeOf(next) > 8192) refuse('IDP_REFUSED');
      result.dryRun = env.dry(ctx.dryRun, 'claims_write');
      if (!result.dryRun) {
        env.write();
        h.set(next);
      }
      return result;
    },
  };
}
