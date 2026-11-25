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
}

export type Layout = 'v2' | 'admin';

/** Roles the binding may write. The platform admin and user groups are registry entries it only reads. */
export const WRITABLE_ROLES = ['console', 'developer', 'support'] as const;
export type WritableRole = (typeof WRITABLE_ROLES)[number];
export type Role = WritableRole | 'platform_admin' | 'users';

export type SignupKind = 'member' | 'developer' | 'member_developer';
export const SIGNUP_KINDS: readonly SignupKind[] = ['member', 'developer', 'member_developer'];
export const KIND_ROLES: Record<SignupKind, WritableRole[]> = {
  member: ['console'],
  developer: ['developer'],
  member_developer: ['developer', 'console'],
};

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
  groups: Partial<Record<Role, string | null>>;
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
}
export type SkipReason = 'already' | 'absent' | 'not_ours';
export interface ApplyResult {
  added: WritableRole[];
  removed: WritableRole[];
  skipped: { role: WritableRole; reason: SkipReason }[];
  dryRun: boolean;
}
export type AccountClass = 'created' | 'linked' | 'external';
export interface Lookup {
  /** Registry roles the account holds, protected ones included. */
  roles: Role[];
  disabled: boolean;
  isAdmin: boolean;
  class: AccountClass;
  /** Roles with a live grant. */
  grants: WritableRole[];
}
export interface SnapshotMember {
  subject: string;
  disabled: boolean;
  isAdmin: boolean;
  grant: boolean;
}
export interface Snapshot {
  roles: Partial<Record<Role, { name: string; members: SnapshotMember[] }>>;
  /** Grants ended because the member is no longer in the group (`idp_removed`). */
  ended: { subject: string; role: WritableRole }[];
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

/** The RPC surface of the `polaris-binding` Worker, and nothing else. No method takes a group. */
export interface IdpRpc {
  health(): Promise<Health>;
  createSignup(kind: SignupKind, ctx: WriteCtx): Promise<SignupRef | DryRun>;
  deleteSignup(tokenId: string, ctx: WriteCtx): Promise<'deleted' | 'used' | 'gone' | DryRun>;
  proveSignup(tokenIds: string[], subject?: string): Promise<ProofResult | null>;
  findByVerifiedEmail(email: string, ctx: WriteCtx): Promise<{ subject: string } | null>;
  lookup(subject: string): Promise<Lookup>;
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
  /** `since` (epoch ms) widens `ended` to every grant ended for a missing member since then. */
  snapshot(ctx: WriteCtx & { since?: number }): Promise<Snapshot>;
  freeze(reason: string, ctx: WriteCtx): Promise<'frozen' | 'already'>;
  /** Ledger rows from `since`, 1,000 at a time; pass the last row's id as `afterId` for the next page. */
  calls(since: number, afterId?: number): Promise<CallRow[]>;
}
