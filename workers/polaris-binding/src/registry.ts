import { type BindingEnv, type Role, WRITABLE_ROLES, type WritableRole } from './types.ts';

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROLES: readonly Role[] = [...WRITABLE_ROLES, 'platform_admin', 'users'];
const PROTECTED_ROLES: readonly Role[] = ['platform_admin', 'users'];

export interface Entry {
  role: Role;
  id: string;
  name: string;
  /** Read only: never written, whatever the caller asks. */
  protected: boolean;
}

export interface Registry {
  entries: Entry[];
  writable: Entry[];
  protectedIds: string[];
  ids: string[];
  entry(role: Role): Entry | undefined;
  /** The group id of a role the caller may write, or undefined (unmapped, protected). */
  writableId(role: string): string | undefined;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Reads the `GROUPS` JSON. The registry is the only way a role becomes a group id: no RPC carries one.
 * Anything malformed is a settings reason, not a throw, so health can report it.
 */
export function parseRegistry(env: BindingEnv): { registry: Registry | null; reasons: string[] } {
  const bad = (...reasons: string[]) => ({ registry: null, reasons });
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
  for (const [role, value] of Object.entries(raw)) {
    const v = value as { id?: unknown; name?: unknown; protected?: unknown } | null;
    if (!ROLES.includes(role as Role) || !v || typeof v !== 'object') return bad('env_groups');
    if (typeof v.id !== 'string' || !ID.test(v.id) || typeof v.name !== 'string' || !v.name)
      return bad('env_groups');
    const isProtected = PROTECTED_ROLES.includes(role as Role);
    // A protected role must say so, and a writable one must not: the flag cannot be argued away.
    if ((v.protected === true) !== isProtected) return bad('env_groups');
    if (!isProtected && prefix && !v.name.startsWith(prefix)) reasons.add('env_group_prefix');
    entries.push({ role: role as Role, id: v.id, name: v.name, protected: isProtected });
  }
  const writable = entries.filter((e) => !e.protected);
  const ids = entries.map((e) => e.id);
  if (!writable.length || new Set(ids).size !== ids.length) return bad('env_groups');
  const protectedNames = entries.filter((e) => e.protected).map((e) => e.name);
  if (writable.some((e) => protectedNames.includes(e.name))) reasons.add('group_protected');
  const registry: Registry = {
    entries,
    writable,
    ids,
    protectedIds: entries.filter((e) => e.protected).map((e) => e.id),
    entry: (role) => entries.find((e) => e.role === role),
    writableId: (role) => writable.find((e) => e.role === (role as WritableRole))?.id,
  };
  return { registry, reasons: [...reasons] };
}
