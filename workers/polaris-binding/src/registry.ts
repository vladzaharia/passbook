import { listedKeyOk } from './claims.ts';
import {
  type BindingEnv,
  type Role,
  type Target,
  WRITABLE_ROLES,
  type WritableRole,
} from './types.ts';

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const GROUP_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const ROLES: readonly Role[] = [...WRITABLE_ROLES, 'platform_admin', 'users'];
const PROTECTED_ROLES: readonly Role[] = ['platform_admin', 'users'];

export interface Entry {
  role: Role;
  id: string;
  name: string;
  /** Read only: never written, whatever the caller asks. */
  protected: boolean;
}

/** A writable role the config lists without an id: `ensureRoleGroup` may create it. */
export interface Unplaced {
  role: WritableRole;
  name: string;
  friendlyName: string;
}

/** A custom or adopted group, by key. */
export interface Custom {
  key: string;
  id: string;
  /** The recorded name: writes need the live name to equal it. */
  name: string;
  kind: 'custom' | 'adopted';
}

export interface Registry {
  entries: Entry[];
  writable: Entry[];
  unplaced: Unplaced[];
  /** Groups the binding never writes. */
  protectedIds: string[];
  /** Platform admin groups: their members are never edited. */
  adminIds: string[];
  /** Role and protected group ids (the PassBook client allows exactly these). */
  ids: string[];
  custom: Custom[];
  /** Every id the binding may write: role groups and custom or adopted groups. */
  managedIds: string[];
  /** Every id the binding knows, protected groups included. */
  allIds: string[];
  entry(role: Role): Entry | undefined;
  /** The group id of a role the caller may write, or undefined (unmapped, protected). */
  writableId(role: string): string | undefined;
  /** The id of a role or `g:<key>` target, or undefined when it is not managed. */
  targetId(target: string): string | undefined;
}

export interface Settings {
  customPrefix: string;
  customLimit: number;
  /** Adopted groups the owner listed: key to id. */
  adopt: { key: string; id: string }[];
  claimKeys: string[];
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function build(entries: Entry[], unplaced: Unplaced[], custom: Custom[]): Registry {
  const writable = entries.filter((e) => !e.protected);
  const ids = entries.map((e) => e.id);
  return {
    entries,
    writable,
    unplaced,
    ids,
    custom,
    protectedIds: entries.filter((e) => e.protected).map((e) => e.id),
    adminIds: entries.filter((e) => e.role === 'platform_admin').map((e) => e.id),
    managedIds: [...writable.map((e) => e.id), ...custom.map((c) => c.id)],
    allIds: [...ids, ...custom.map((c) => c.id)],
    entry: (role) => entries.find((e) => e.role === role),
    writableId: (role) => writable.find((e) => e.role === (role as WritableRole))?.id,
    targetId(target) {
      if (target.startsWith('g:')) return custom.find((c) => `g:${c.key}` === target)?.id;
      return writable.find((e) => e.role === (target as WritableRole))?.id;
    },
  };
}

/** Adds the groups the binding recorded: role groups it created, custom and adopted groups. */
export function withRecorded(
  base: Registry,
  roles: { role: WritableRole; id: string; name: string }[],
  custom: Custom[],
): Registry {
  const entries = [
    ...base.entries,
    ...roles
      .filter((r) => !base.entries.some((e) => e.role === r.role))
      .map((r) => ({ role: r.role, id: r.id, name: r.name, protected: false })),
  ];
  const placed = new Set(roles.map((r) => r.role));
  return build(
    entries,
    base.unplaced.filter((u) => !placed.has(u.role)),
    custom,
  );
}

function parseSettings(env: BindingEnv, reasons: Set<string>, registryIds: string[]): Settings {
  const customPrefix = env.CUSTOM_GROUP_PREFIX ?? 'passbook_g_';
  const prefix = text(env.GROUP_PREFIX);
  if (!customPrefix.startsWith(prefix) || !prefix || !/^[a-z0-9_]+$/.test(customPrefix))
    reasons.add('env_custom_prefix');
  const limit = Number(env.CUSTOM_GROUP_LIMIT ?? '50');
  if (!Number.isInteger(limit) || limit < 0 || limit > 500) reasons.add('env_custom_limit');
  const adopt: Settings['adopt'] = [];
  try {
    const raw: unknown = JSON.parse(env.ADOPT_GROUPS ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('shape');
    for (const [key, id] of Object.entries(raw)) {
      if (
        !GROUP_KEY.test(key) ||
        (ROLES as readonly string[]).includes(key) ||
        typeof id !== 'string' ||
        !ID.test(id) ||
        registryIds.includes(id) ||
        adopt.some((a) => a.id === id)
      )
        throw new Error('entry');
      adopt.push({ key, id });
    }
  } catch {
    reasons.add('env_adopt');
  }
  let claimKeys: string[] = [];
  try {
    const raw: unknown = JSON.parse(env.CLAIM_KEYS ?? '[]');
    if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) throw new Error('shape');
    if (!(raw as string[]).every(listedKeyOk)) throw new Error('key');
    claimKeys = raw as string[];
  } catch {
    reasons.add('env_claim_keys');
  }
  return { customPrefix, customLimit: limit, adopt, claimKeys };
}

/**
 * Reads the `GROUPS` JSON. The registry is the only way a role becomes a group id: no RPC carries one.
 * A writable role may omit its id (`ensureRoleGroup` creates it). Anything malformed is a settings reason, not a
 * throw, so health can report it.
 */
export function parseRegistry(env: BindingEnv): {
  registry: Registry | null;
  settings: Settings | null;
  reasons: string[];
} {
  const bad = (...reasons: string[]) => ({ registry: null, settings: null, reasons });
  let raw: unknown;
  try {
    raw = JSON.parse(text(env.GROUPS));
  } catch {
    return bad('env_groups');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('env_groups');
  const prefix = text(env.GROUP_PREFIX);
  const reasons = new Set<string>();
  if (!prefix) reasons.add('env_group_prefix');
  const entries: Entry[] = [];
  const unplaced: Unplaced[] = [];
  const names: string[] = [];
  for (const [role, value] of Object.entries(raw)) {
    if (!ROLES.includes(role as Role)) return bad('env_groups');
    const isProtected = PROTECTED_ROLES.includes(role as Role);
    // The protected roles may list several groups, for the window where a group is renamed.
    const list = isProtected && Array.isArray(value) ? (value as unknown[]) : [value];
    for (const item of list) {
      const v = item as {
        id?: unknown;
        name?: unknown;
        friendlyName?: unknown;
        protected?: unknown;
      } | null;
      if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name)
        return bad('env_groups');
      // A protected role must say so, and a writable one must not: the flag cannot be argued away.
      if ((v.protected === true) !== isProtected) return bad('env_groups');
      if (!isProtected && prefix && !v.name.startsWith(prefix)) reasons.add('env_group_prefix');
      // A writable name that reads as an admin group is a misconfigured admin group.
      if (!isProtected && /admin/i.test(v.name)) reasons.add('group_admin_name');
      names.push(v.name);
      const noId = v.id === undefined || v.id === null;
      if (noId && !isProtected) {
        const friendly = typeof v.friendlyName === 'string' ? v.friendlyName : v.name;
        if (friendly.length < 2 || friendly.length > 50) return bad('env_groups');
        unplaced.push({ role: role as WritableRole, name: v.name, friendlyName: friendly });
        continue;
      }
      if (typeof v.id !== 'string' || !ID.test(v.id)) return bad('env_groups');
      entries.push({ role: role as Role, id: v.id, name: v.name, protected: isProtected });
    }
  }
  const ids = entries.map((e) => e.id);
  if ((!entries.some((e) => !e.protected) && !unplaced.length) || new Set(ids).size !== ids.length)
    return bad('env_groups');
  // Without the admin group nothing can tell an admin from a member, so there is no write at all.
  if (!entries.some((e) => e.role === 'platform_admin')) return bad('env_groups');
  const protectedNames = entries.filter((e) => e.protected).map((e) => e.name);
  if (
    [
      ...entries.filter((e) => !e.protected).map((e) => e.name),
      ...unplaced.map((u) => u.name),
    ].some((n) => protectedNames.includes(n))
  )
    reasons.add('group_protected');
  if (new Set(names).size !== names.length && !reasons.has('group_protected'))
    return bad('env_groups');
  const settings = parseSettings(env, reasons, ids);
  return { registry: build(entries, unplaced, []), settings, reasons: [...reasons] };
}

export type { Target };
