/** Codes carried as the `CODE: ` prefix of an RPC error message (custom error fields do not cross RPC). */
export const IDP_CODES = [
  'IDP_REFUSED',
  'IDP_BUDGET',
  'IDP_AUTH',
  'IDP_NOT_FOUND',
  'IDP_CONFLICT',
  'IDP_UPSTREAM',
  'IDP_UNSAFE_CONFIG',
  'IDP_DRIFT',
  'IDP_MISCONFIGURED',
  'IDP_FROZEN',
  'IDP_BREAKER',
  'IDP_NOT_MANAGED',
  'IDP_IN_USE',
] as const;
export type IdpCode = (typeof IDP_CODES)[number];

export class IdpError extends Error {
  readonly code: IdpCode;
  constructor(code: IdpCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'IdpError';
    this.code = code;
  }
}

export interface BindingEnv {
  DB: D1Database;
  POCKET_ID_API_KEY: string;
  POCKET_ID_ORIGIN: string;
  /** `v2` is Polaris ID on Pocket ID v2.19.x (`/api/...`); `admin` is the next release (`/api/admin/...`). */
  POCKET_ID_API: string;
  /** JSON role registry (registry.ts). */
  GROUPS: string;
  GROUP_PREFIX: string;
  /** `dry_run` (anything but `live`) computes and ledgers writes and sends none. */
  WRITE_MODE: string;
  PASSBOOK_CLIENT_ID: string;
  /** Custom group names are this prefix plus the key. Default `passbook_g_`. */
  CUSTOM_GROUP_PREFIX?: string;
  /** Custom plus adopted groups at most. Default 50. */
  CUSTOM_GROUP_LIMIT?: string;
  /** JSON `{ key: groupId }`: groups outside the namespace the owner lets the binding manage. */
  ADOPT_GROUPS?: string;
  /** JSON list of exact claim keys outside `passbook_*` the binding may write. */
  CLAIM_KEYS?: string;
}

export type Layout = 'v2' | 'admin';

/** Roles the binding may write. The platform admin and user groups are registry entries it only reads. */
export const WRITABLE_ROLES = ['console', 'developer', 'support'] as const;
export type WritableRole = (typeof WRITABLE_ROLES)[number];
export type Role = WritableRole | 'platform_admin' | 'users';

export type SignupKind = 'member' | 'developer' | 'member_developer' | 'platform';
export const SIGNUP_KINDS: readonly SignupKind[] = [
  'member',
  'developer',
  'member_developer',
  'platform',
];
export const KIND_ROLES: Record<SignupKind, WritableRole[]> = {
  member: ['console'],
  developer: ['developer'],
  member_developer: ['developer', 'console'],
  platform: [],
};

/** A role the binding writes, or `g:<key>` for a custom or adopted group. Never a Polaris ID id or name. */
export type Target = WritableRole | `g:${string}`;
export type GroupKey = string;
/** What a signup token carries: the kind's roles plus up to 5 custom or adopted group keys. */
export interface SignupSpec {
  kind: SignupKind;
  groups?: GroupKey[];
}

export type Actor = { kind: 'user' | 'key'; id: string } | { kind: 'system'; job: string };
/** Who and why. The actor is the caller's word: it is ledgered and picks budgets, nothing more. */
export interface WriteCtx {
  ref: string;
  reason: string;
  actor: Actor;
  dryRun?: boolean;
}
export type ApplyCtx = WriteCtx & { override?: boolean };

export const BUCKETS = [
  'health',
  'createSignup',
  'findByVerifiedEmail',
  'apply_add',
  'apply_add_system',
  'apply_remove',
  'apply_override',
  'setDisabled',
  'snapshot',
  'proveSignup',
  'deleteSignup',
  'lookup',
  'preview',
  'group_write',
  'claims_write',
  'claims_read',
  'apply_add_group',
  'apply_add_group_system',
  'snapshot_group',
] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface Health {
  /** True when config is safe and changes are not frozen. */
  ok: boolean;
  /** Reasons writes are refused (`IDP_UNSAFE_CONFIG`). */
  unsafe: string[];
  /** Findings that do not block writes (`client_open`). */
  warnings: string[];
  /** Live group name per registry role, or null when the group was not found. */
  groups: Record<string, string | null>;
  layout: string;
  /** Every group read answered 404: the key or `POCKET_ID_API` points at the wrong route layout. */
  layoutSuspect: boolean;
  /** Epoch ms of the nearest expiry among the key owner's keys, or null. */
  keyExpiresAt: number | null;
  checkedAt: number;
  mode: 'dry_run' | 'live';
  frozen: boolean;
  /** Today's starts per budget bucket against the daily budget. */
  budget: Record<string, { day: number; limit: number }>;
}

export interface DryRun {
  dryRun: true;
}
export interface SignupRef {
  tokenId: string;
  /** The Polaris ID signup link. Secret: never logged or stored here. */
  url: string;
  expiresAt: number;
}
export interface ProvedSignup {
  tokenId: string;
  subject: string;
}
export interface ProofResult extends ProvedSignup {
  /** Every token that matched in this call (a sweep records all of them). */
  matches: ProvedSignup[];
  /** With `email`: whether the proven account uses that address, verified. The address is never returned. */
  emailMatch?: 'match' | 'mismatch' | 'unverified';
}
export type SkipReason = 'already' | 'absent' | 'not_ours';
export interface ApplyResult {
  added: Target[];
  removed: Target[];
  skipped: { role: Target; reason: SkipReason }[];
  dryRun: boolean;
}
export type AccountClass = 'created' | 'linked' | 'external';
export interface Lookup {
  /** Registry roles the account holds (protected ones included) and `g:<key>` for managed groups. */
  roles: (Role | `g:${string}`)[];
  disabled: boolean;
  isAdmin: boolean;
  class: AccountClass;
  /** Targets with a live grant. */
  grants: Target[];
}
export interface SnapshotMember {
  subject: string;
  disabled: boolean;
  isAdmin: boolean;
  grant: boolean;
}
export interface Snapshot {
  /** Keyed by role, or `g:<key>` for a managed group. */
  roles: Record<string, { name: string; members: SnapshotMember[] }>;
  /** Grants ended because the member is no longer in the group (`idp_removed`). `role` is a target. */
  ended: { subject: string; role: Target }[];
}

export type ClaimType = 'text' | 'number' | 'boolean' | 'json';
/** One managed claim value, typed. `null` in a change removes the key. */
export interface ClaimValue {
  type: ClaimType;
  value: unknown;
}
export type ClaimChange = ClaimValue | null;
export type ClaimOwner = { subject: string } | { group: Target };
export interface ClaimView {
  /** Managed keys only. */
  claims: Record<string, ClaimValue>;
  /** Keys other apps or the owner set, which the binding may not touch. Never listed. */
  otherKeys: number;
}
export interface ManagedGroup {
  /** The role name, or the group key. */
  key: string;
  kind: 'role' | 'custom' | 'adopted';
  name: string;
  friendlyName: string | null;
  members: number | null;
  claims: string[];
  /** Allowed OIDC clients other than PassBook's. */
  otherClients: number | null;
  /** Why this group blocks writes, such as `group_name_mismatch`. */
  flags: string[];
}
export interface CallRow {
  id: number;
  callId: string;
  phase: string;
  method: string;
  bucket: string | null;
  target: string | null;
  caller: string | null;
  actor: string | null;
  reason: string | null;
  role: string | null;
  delta: string | null;
  status: string | null;
  requestId: string | null;
  durationMs: number | null;
  at: number;
}

/** The RPC surface of the `polaris-binding` Worker, and nothing else. No method takes a Polaris ID group id or name. */
export interface IdpRpc {
  health(): Promise<Health>;
  groups(): Promise<ManagedGroup[]>;
  createGroup(
    key: GroupKey,
    friendlyName: string,
    ctx: WriteCtx,
  ): Promise<{ key: GroupKey } | DryRun>;
  ensureRoleGroup(role: WritableRole, ctx: WriteCtx): Promise<{ key: WritableRole } | DryRun>;
  updateGroup(
    target: Target,
    change: { friendlyName: string },
    ctx: WriteCtx,
  ): Promise<{ target: Target } | DryRun>;
  deleteGroup(key: GroupKey, ctx: WriteCtx): Promise<{ key: GroupKey } | DryRun>;
  claims(owner: ClaimOwner): Promise<ClaimView>;
  setClaims(
    owner: ClaimOwner,
    changes: Record<string, ClaimChange>,
    ctx: WriteCtx,
  ): Promise<{ set: string[]; removed: string[]; dryRun: boolean }>;
  createSignup(spec: SignupSpec, ctx: WriteCtx): Promise<SignupRef | DryRun>;
  deleteSignup(tokenId: string, ctx: WriteCtx): Promise<'deleted' | 'used' | 'gone' | DryRun>;
  proveSignup(
    tokenIds: string[],
    opts?: { subject?: string; email?: string },
  ): Promise<ProofResult | null>;
  findByVerifiedEmail(email: string, ctx: WriteCtx): Promise<{ subject: string } | null>;
  lookup(subject: string): Promise<Lookup>;
  apply(
    subject: string,
    delta: { add?: Target[]; remove?: Target[] },
    ctx: ApplyCtx,
  ): Promise<ApplyResult>;
  setDisabled(
    subject: string,
    disabled: boolean,
    ctx: WriteCtx,
  ): Promise<{ result: 'disabled' | 'enabled' | 'already'; dryRun: boolean }>;
  /** `since` (epoch ms) widens `ended` to every grant ended for a missing member since then. */
  snapshot(ctx: WriteCtx & { since?: number }): Promise<Snapshot>;
  freeze(reason: string, ctx: WriteCtx): Promise<'frozen' | 'already'>;
  /** Ledger rows from `since`, 1,000 at a time; pass the last row's id as `afterId` for the next page. */
  calls(since: number, afterId?: number): Promise<CallRow[]>;
}
