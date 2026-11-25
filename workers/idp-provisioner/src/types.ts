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

export interface ProvisionerEnv {
  DB: D1Database;
  POCKET_ID_API_KEY: string;
  POCKET_ID_ORIGIN: string;
  /** `v2` is Pocket ID v2.19.x (`/api/...`); `admin` is the next release (`/api/admin/...`). */
  POCKET_ID_API: string;
  DEVELOPER_GROUP_ID: string;
  DEVELOPER_GROUP_NAME: string;
  PROTECTED_GROUP_NAMES: string;
}

export type Layout = 'v2' | 'admin';

export const BUDGETED = [
  'health',
  'createSignup',
  'addDeveloper',
  'removeDeveloper',
  'proveSignup',
  'deleteSignup',
] as const;
export type Budgeted = (typeof BUDGETED)[number];

export interface Health {
  /** True when writes are allowed. */
  ok: boolean;
  /** Reasons writes are refused (`IDP_UNSAFE_CONFIG`). */
  unsafe: string[];
  groupName: string | null;
  layout: string;
  /** The group read answered 404: the key or `POCKET_ID_API` points at the wrong route layout. */
  layoutSuspect: boolean;
  /** Epoch ms of the nearest expiry among the key owner's keys, or null. */
  keyExpiresAt: number | null;
  checkedAt: number;
  /** Today's starts per method against the daily budget. */
  budget: Record<string, { day: number; limit: number }>;
}

export interface SignupRef {
  tokenId: string;
  /** The Pocket ID signup link. Secret: never logged or stored here. */
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
export interface CallRow {
  id: number;
  callId: string;
  phase: string;
  method: string;
  target: string | null;
  caller: string | null;
  status: string | null;
  requestId: string | null;
  durationMs: number | null;
  at: number;
}

/** The RPC surface of the `idp-provisioner` Worker, and nothing else. No method takes a group. */
export interface IdpRpc {
  health(): Promise<Health>;
  createSignup(ref: string): Promise<SignupRef>;
  deleteSignup(tokenId: string): Promise<'deleted' | 'used' | 'gone'>;
  proveSignup(tokenIds: string[], subject?: string): Promise<ProofResult | null>;
  addDeveloper(subject: string, ref: string): Promise<'added' | 'already'>;
  removeDeveloper(subject: string, reason: string): Promise<'removed' | 'absent' | 'not_ours'>;
  calls(since: number): Promise<CallRow[]>;
}
