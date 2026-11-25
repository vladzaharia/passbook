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
] as const;
export type IdpCode = (typeof IDP_CODES)[number];

export const WRITABLE_ROLES = ['console', 'developer', 'support'] as const;
export type WritableRole = (typeof WRITABLE_ROLES)[number];
export type Role = WritableRole | 'platform_admin' | 'users';

export type SignupKind = 'member' | 'developer' | 'member_developer';

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
}
export type SkipReason = 'already' | 'absent' | 'not_ours';
export interface ApplyResult {
  added: WritableRole[];
  removed: WritableRole[];
  skipped: { role: WritableRole; reason: SkipReason }[];
  dryRun: boolean;
}
export type AccountClass = 'created' | 'linked' | 'external';
export interface IdpLookup {
  roles: Role[];
  disabled: boolean;
  isAdmin: boolean;
  class: AccountClass;
  grants: WritableRole[];
}
export interface SnapshotMember {
  subject: string;
  disabled: boolean;
  isAdmin: boolean;
  grant: boolean;
}
export interface IdpSnapshot {
  roles: Partial<Record<Role, { name: string; members: SnapshotMember[] }>>;
  ended: { subject: string; role: WritableRole }[];
}
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
  createSignup(kind: SignupKind, ctx: WriteCtx): Promise<IdpSignup | IdpDryRun>;
  deleteSignup(tokenId: string, ctx: WriteCtx): Promise<'deleted' | 'used' | 'gone' | IdpDryRun>;
  proveSignup(tokenIds: string[], subject?: string): Promise<ProofResult | null>;
  findByVerifiedEmail(email: string, ctx: WriteCtx): Promise<{ subject: string } | null>;
  lookup(subject: string): Promise<IdpLookup>;
  apply(
    subject: string,
    delta: { add?: WritableRole[]; remove?: WritableRole[] },
    ctx: ApplyCtx,
  ): Promise<ApplyResult>;
  setDisabled(
    subject: string,
    disabled: boolean,
    ctx: WriteCtx,
  ): Promise<{ result: 'disabled' | 'enabled' | 'already'; dryRun: boolean }>;
  snapshot(ctx: WriteCtx): Promise<IdpSnapshot>;
  freeze(reason: string, ctx: WriteCtx): Promise<'frozen' | 'already'>;
  calls(since: number): Promise<IdpCall[]>;
}
