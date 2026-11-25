// The `IDP` service binding's RPC surface. Mirrors workers/polaris-binding/src/types.ts; types.test.ts fails on drift.
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

export const WRITABLE_ROLES = ['console', 'developer', 'support'] as const;
export type WritableRole = (typeof WRITABLE_ROLES)[number];
export type Role = WritableRole | 'platform_admin' | 'users';

export type SignupKind = 'member' | 'developer' | 'member_developer' | 'platform';
/** A custom or adopted group, by key. Polaris ID ids and names never cross RPC. */
export type GroupKey = string;
export type GroupTarget = `g:${GroupKey}`;
/** What `apply` adds or removes: a writable role or a group. */
export type Target = WritableRole | GroupTarget;
export interface SignupSpec {
  kind: SignupKind;
  /** Custom or adopted group keys, at most 5. A `platform` signup needs at least one. */
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

export interface IdpHealth {
  ok: boolean;
  unsafe: string[];
  warnings: string[];
  groups: Partial<Record<Role, string | null>>;
  layout: string;
  layoutSuspect: boolean;
  keyExpiresAt: number | null;
  checkedAt: number;
  mode: 'dry_run' | 'live';
  frozen: boolean;
  budget: Record<string, { day: number; limit: number }>;
}

export interface IdpDryRun {
  dryRun: true;
}
export interface IdpSignup {
  tokenId: string;
  /** A bearer link: never logged or stored. */
  url: string;
  expiresAt: number;
}
export interface ProvedSignup {
  tokenId: string;
  subject: string;
}
export interface ProofResult extends ProvedSignup {
  matches: ProvedSignup[];
  /** Only when `email` was passed: the proven account against the invited address. */
  emailMatch?: EmailMatch;
}
export type SkipReason = 'already' | 'absent' | 'not_ours';
export interface ApplyResult {
  added: Target[];
  removed: Target[];
  skipped: { role: Target; reason: SkipReason }[];
  dryRun: boolean;
}
export type AccountClass = 'created' | 'linked' | 'external';
export interface IdpLookup {
  roles: (Role | GroupTarget)[];
  disabled: boolean;
  isAdmin: boolean;
  class: AccountClass;
  grants: Target[];
}
export interface SnapshotMember {
  subject: string;
  disabled: boolean;
  isAdmin: boolean;
  grant: boolean;
}
export interface IdpSnapshot {
  roles: Partial<Record<Role | GroupTarget, { name: string; members: SnapshotMember[] }>>;
  ended: { subject: string; role: Target }[];
}
export interface ManagedGroup {
  /** The role name for a role group, else the group key. */
  key: string;
  kind: 'role' | 'custom' | 'adopted';
  name: string;
  friendlyName: string;
  members: number;
  /** Managed claim keys set on the group. */
  claims: string[];
  /** Allowed clients other than PassBook's. */
  otherClients: number;
  drift: string[];
}
export type ClaimValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'json'; value: unknown };
/** A claim to set, or `null` to remove it. */
export type ClaimChange = ClaimValue | null;
export type ClaimOwner = { subject: string } | { group: Target };
export interface ClaimView {
  claims: Record<string, ClaimValue>;
  /** Keys PassBook may not touch; never shown. */
  otherKeys: number;
}
export type EmailMatch = 'match' | 'mismatch' | 'unverified';
export interface IdpCall {
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

export interface IdpRpc {
  health(): Promise<IdpHealth>;
  groups(): Promise<ManagedGroup[]>;
  createGroup(
    key: GroupKey,
    friendlyName: string,
    ctx: WriteCtx,
  ): Promise<ManagedGroup | IdpDryRun>;
  ensureRoleGroup(role: WritableRole, ctx: WriteCtx): Promise<ManagedGroup | IdpDryRun>;
  updateGroup(
    target: WritableRole | GroupKey,
    patch: { friendlyName: string },
    ctx: WriteCtx,
  ): Promise<ManagedGroup | IdpDryRun>;
  deleteGroup(key: GroupKey, ctx: WriteCtx): Promise<'deleted' | 'gone' | IdpDryRun>;
  claims(owner: ClaimOwner): Promise<ClaimView>;
  setClaims(
    owner: ClaimOwner,
    changes: Record<string, ClaimChange>,
    ctx: WriteCtx,
  ): Promise<{ set: string[]; removed: string[]; dryRun: boolean }>;
  createSignup(spec: SignupSpec, ctx: WriteCtx): Promise<IdpSignup | IdpDryRun>;
  deleteSignup(tokenId: string, ctx: WriteCtx): Promise<'deleted' | 'used' | 'gone' | IdpDryRun>;
  proveSignup(
    tokenIds: string[],
    opts?: { subject?: string; email?: string },
  ): Promise<ProofResult | null>;
  findByVerifiedEmail(email: string, ctx: WriteCtx): Promise<{ subject: string } | null>;
  lookup(subject: string): Promise<IdpLookup>;
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
  snapshot(ctx: WriteCtx & { since?: number }): Promise<IdpSnapshot>;
  freeze(reason: string, ctx: WriteCtx): Promise<'frozen' | 'already'>;
  /** Ledger rows from `since`, 1,000 at a time; pass the last row's id as `afterId` for the next page. */
  calls(since: number, afterId?: number): Promise<IdpCall[]>;
}
