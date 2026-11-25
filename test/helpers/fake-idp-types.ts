import type {
  IdpRpc,
  IdpSignup,
  Role,
  SignupKind,
  Target,
} from '../../src/worker/modules/idp/types.ts';
import type { FakeAccount, FakeGroup } from './fake-idp-groups.ts';

export interface FakeIdp extends IdpRpc {
  /** The `IDP` binding for a test env. */
  binding: IdpRpc;
  /** Signup tokens minted and not deleted, by id. */
  signups: Map<
    string,
    IdpSignup & { kind: SignupKind; targets: Target[]; ref: string; used: boolean }
  >;
  /** Role groups (seeded: console, developer), custom and adopted groups, by role or key. */
  groupStore: Map<string, FakeGroup>;
  accounts: Map<string, FakeAccount>;
  /** Method names called, in order. */
  log: string[];
  /** Writes the binding would have sent to Polaris ID. Dry runs and refusals add none. */
  writes: number;
  frozen: boolean;
  mode: 'dry_run' | 'live';
  /** Makes the next call to `method` (or any call with `*`) fail as the binding does: `CODE: text`. */
  failNext(code: string, method?: string): void;
  /** Another write holds this subject or `g:<key>`; writes that need it answer `IDP_CONFLICT`. */
  holdLease(key: string): void;
  /** The person finished signup with this token: `proveSignup` now finds them. */
  completeSignup(
    tokenId: string,
    subject: string,
    account?: { email?: string; emailVerified?: boolean },
  ): void;
  /** Seeds an account that already exists in Polaris ID. */
  addAccount(
    subject: string,
    init?: Partial<Omit<FakeAccount, 'roles' | 'grants'>> & { roles?: (Role | `g:${string}`)[] },
  ): void;
}

export interface FakeIdpOptions {
  now?: () => number;
  mode?: 'dry_run' | 'live';
  /** The key owner's subject: never writable. */
  keyUser?: string;
  /** Starts allowed per bucket (`apply_add`, `group_write`, `preview`, ...) before `IDP_BUDGET`. */
  budget?: Partial<Record<string, number>>;
  /** Live removals allowed in this fake's lifetime before `IDP_BREAKER` (the binding allows 25 a run). */
  breaker?: number;
  /** Groups outside the namespace the owner lets PassBook manage (`ADOPT_GROUPS`): key to name. */
  adopt?: Record<string, string>;
  /** `CLAIM_KEYS`: exact claim keys outside `passbook_*`. */
  claimKeys?: string[];
  /** `CUSTOM_GROUP_LIMIT`. */
  customLimit?: number;
}
