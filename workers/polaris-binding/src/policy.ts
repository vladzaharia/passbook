import {
  clientIdOk,
  encodeClientId,
  GROUP_KEY,
  ID,
  parseRegistry,
  type Registry,
  type Settings,
} from './registry.ts';
import {
  type Actor,
  type ApplyCtx,
  type BindingEnv,
  IdpError,
  SIGNUP_KINDS,
  type SignupKind,
  type Target,
  WRITABLE_ROLES,
  type WritableRole,
} from './types.ts';

export { ID };

/** The configured client id as its path segment: plain as is, a CIMD URL as `~<base64url>`. */
export function assertClientId(value: unknown): string {
  if (!clientIdOk(value)) refuse('Invalid client id.');
  return encodeClientId(value as string);
}
/** Writes read the config at most this often; an unsafe answer is re-read sooner. */
export const HEALTH_TTL = 10 * 60_000;
export const UNSAFE_TTL = 60_000;

export function refuse(message: string): never {
  throw new IdpError('IDP_REFUSED', message);
}

export function assertId(kind: string, value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) refuse(`Invalid ${kind}.`);
  return value as string;
}

/** `me` is Polaris ID's alias for the key's own user: never an account to change. */
export function assertSubject(value: unknown): string {
  const id = assertId('subject', value);
  if (id === 'me') refuse('Invalid subject.');
  return id;
}

export function assertTokenIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) refuse('Invalid token ids.');
  return [...new Set((value as unknown[]).map((v) => assertId('token id', v)))];
}

/** At most two SHA-256 hex digests: the candidate SCIM tokens `setupStatus` compares with the live one. */
export function assertTokenHashes(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 2 ||
    value.some((h) => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))
  )
    refuse('Invalid token hashes.');
  return value as string[];
}

/** A SCIM token: base64url, 43 to 128 chars. The message never carries the value. */
export function assertScimToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) refuse('Invalid token.');
  return value as string;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const REASON = /^[a-z][a-z0-9_]{0,39}$/;
export function assertReason(value: unknown): string {
  if (typeof value !== 'string' || !REASON.test(value)) refuse('Invalid reason.');
  return value as string;
}

export function assertEmail(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
    value.includes('..')
  )
    refuse('Invalid email.');
  return (value as string).toLowerCase();
}

/** An optional epoch-ms lower bound. */
export function assertSince(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    refuse('Invalid since.');
  return value as number;
}

export function assertKind(value: unknown): SignupKind {
  if (!SIGNUP_KINDS.includes(value as SignupKind)) refuse('Invalid signup kind.');
  return value as SignupKind;
}

export interface Ctx {
  ref: string;
  reason: string;
  /** `kind:id`, as ledgered. */
  actor: string;
  system: boolean;
  dryRun: boolean;
  override: boolean;
}

export function assertCtx(value: unknown): Ctx {
  const v = value as Partial<ApplyCtx> | null;
  if (!v || typeof v !== 'object') refuse('Invalid context.');
  const a = (v as ApplyCtx).actor as Partial<Actor> | null;
  const kind = a && typeof a === 'object' ? a.kind : undefined;
  const who =
    kind === 'system'
      ? (a as { job?: unknown }).job
      : kind === 'user' || kind === 'key'
        ? (a as { id?: unknown }).id
        : undefined;
  if (kind !== 'user' && kind !== 'key' && kind !== 'system') refuse('Invalid actor.');
  for (const flag of [v?.dryRun, v?.override])
    if (flag !== undefined && typeof flag !== 'boolean') refuse('Invalid context.');
  return {
    ref: assertId('ref', v?.ref),
    reason: assertReason(v?.reason),
    actor: `${kind}:${assertId('actor', who)}`,
    system: kind === 'system',
    dryRun: v?.dryRun === true,
    override: v?.override === true,
  };
}

/** A role name or `g:<key>`. Never an id or a name: those are not accepted anywhere. */
export function assertTarget(value: unknown): Target {
  if (WRITABLE_ROLES.includes(value as WritableRole)) return value as WritableRole;
  if (typeof value === 'string' && value.startsWith('g:') && GROUP_KEY.test(value.slice(2)))
    return value as Target;
  return refuse('Invalid target.');
}

export function assertGroupKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !GROUP_KEY.test(value) ||
    /admin/i.test(value) ||
    WRITABLE_ROLES.includes(value as WritableRole)
  )
    refuse('Invalid group key.');
  return value as string;
}

export function assertFriendlyName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.normalize('NFC') ||
    value.trim() !== value ||
    value.length < 2 ||
    value.length > 50 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
  )
    refuse('Invalid group name.');
  return value as string;
}

/** `add` and `remove` as targets (at most 10), never overlapping. Whether the registry maps them is checked later. */
export function assertDelta(value: unknown): { add: Target[]; remove: Target[] } {
  const v = (value ?? {}) as { add?: unknown; remove?: unknown };
  const list = (raw: unknown): Target[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 10) refuse('Invalid roles.');
    return [...new Set((raw as unknown[]).map(assertTarget))];
  };
  const add = list(v.add);
  const remove = list(v.remove);
  if (!add.length && !remove.length) refuse('Nothing to change.');
  if (add.length + remove.length > 10) refuse('Too many changes.');
  if (add.some((r) => remove.includes(r))) refuse('A role cannot be added and removed.');
  return { add, remove };
}

/** A signup spec: a kind, and up to 5 group keys in all. A platform signup needs a group. */
export function assertSpec(value: unknown): { kind: SignupKind; groups: string[] } {
  const v = value as { kind?: unknown; groups?: unknown } | null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return refuse('Invalid signup.');
  const kind = assertKind(v.kind);
  const raw = v.groups ?? [];
  if (!Array.isArray(raw) || raw.length > 5) return refuse('Invalid signup groups.');
  const groups = [...new Set((raw as unknown[]).map(assertGroupKey))];
  if (kind === 'platform' && !groups.length) return refuse('A platform signup needs a group.');
  return { kind, groups };
}

/** The group ids for targets the registry manages. Unmapped, unmanaged and protected targets are refused. */
export function mappedIds(targets: Target[], registry: Registry, adding = false): string[] {
  return targets.map(
    (t) =>
      registry.targetId(t, adding) ??
      refuse(t.startsWith('g:') ? `Group ${t} is not managed.` : `Role ${t} is not mapped.`),
  );
}

/** Reasons the deployment's own settings make writes unsafe. Checked before the cache and before any call. */
export function envReasons(env: BindingEnv): {
  reasons: string[];
  registry: Registry | null;
  settings: Settings | null;
} {
  const { registry, settings, reasons } = parseRegistry(env);
  const out = [...reasons];
  if (env.POCKET_ID_API !== 'v2' && env.POCKET_ID_API !== 'admin') out.push('env_layout');
  if (!env.POCKET_ID_API_KEY) out.push('env_key');
  if (!clientIdOk(env.PASSBOOK_CLIENT_ID)) out.push('env_client');
  try {
    const url = new URL(env.POCKET_ID_ORIGIN);
    if (url.protocol !== 'https:' || url.origin !== env.POCKET_ID_ORIGIN || url.username)
      out.push('env_origin');
  } catch {
    out.push('env_origin');
  }
  return { reasons: out, registry, settings };
}

const emptyList = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  if (raw.trim() === '') return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
};

/**
 * Polaris ID settings that would turn a signup into escalation, and group names that drifted from the registry.
 * A missing key counts as unsafe. `live` is the group name read per registry role, null when not found.
 */
export function configReasons(
  cfg: Record<string, string>,
  live: [role: string, name: string | null, configured: string][],
): string[] {
  const out: string[] = [];
  for (const [role, name, configured] of live) {
    if (name === null) out.push(`group_not_found:${role}`);
    else if (name !== configured) out.push(`group_name_mismatch:${role}`);
  }
  if (cfg.allowUserSignups !== 'withToken') out.push('signups_not_token');
  if (cfg.emailVerification !== 'required') out.push('email_verification_not_required');
  if (cfg.requireUserEmail !== 'true') out.push('require_email_off');
  if (cfg.emailsVerified !== 'false') out.push('emails_verified_on');
  if (!emptyList(cfg.signupDefaultUserGroupIDs)) out.push('default_groups_set');
  return [...new Set(out)];
}

/** The only signup body the binding sends. Only the kind reaches it, through the registry. */
export const signupBody = (groupIds: string[]) => ({
  ttl: '1h',
  usageLimit: 1,
  userGroupIds: groupIds,
});

export const sameSet = (a: string[], b: string[]): boolean =>
  new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));
