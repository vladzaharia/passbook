import type { WriteCtx } from './types.ts';

/** A setup write says whether it is a dry run: it is never inferred from a missing flag. */
export type SetupCtx = WriteCtx & { dryRun: boolean };

/** What `placeRoleGroups` did, or would do, per configured role. */
export type RolePlacement = 'already' | 'recorded' | 'created' | 'adopted' | 'missing' | 'in_use';
export interface PlaceResult {
  roles: Record<string, RolePlacement>;
  dryRun: boolean;
}
/** `adopt`: an existing group would be recorded (protected) or adopted (writable); `create`: a writable group would be made. */
export type RoleState = 'configured' | 'placed' | 'create' | 'adopt' | 'in_use' | 'missing';
export interface SetupStatus {
  client: {
    found: boolean;
    cimd: boolean;
    ours: boolean;
    /** Every callback URL is on PassBook's own origin. Setup writes refuse a client where this is false. */
    callbacksOurs: boolean;
    restricted: boolean;
    /** Placed roles whose group the client does not allow. */
    missingRoles: string[];
    /** Each alias group the main Worker's sign-in accepts: whether it exists and the client allows it. Never written. */
    aliases: { name: string; exists: boolean; allowed: boolean }[];
    /** Allowed groups that are not PassBook's. PassBook never removes them. */
    otherGroups: number;
    logo: boolean;
    darkLogo: boolean;
  };
  roles: Record<string, RoleState>;
  scim: {
    exists: boolean;
    endpointOk: boolean;
    /** Which of the caller's hashes (by index) is the SHA-256 of the live token; null when unknown. */
    token: 0 | 1 | 'other' | null;
    lastSyncedAt: number | null;
  };
}

/**
 * The seven setup RPCs. None takes a Polaris ID id, name, URL or endpoint; the only caller value is a fresh SCIM
 * token. Part of `IdpRpc` (types.ts extends it) so the main Worker's type-equality test covers them.
 */
export interface SetupRpc {
  /** Reads the PassBook client, its SCIM connection and the unplaced role groups. Hashes are SHA-256 hex of candidate SCIM tokens. */
  setupStatus(opts?: { tokenHashes?: string[] }): Promise<SetupStatus>;
  placeRoleGroups(ctx: SetupCtx): Promise<PlaceResult>;
  allowClientGroups(
    ctx: SetupCtx,
  ): Promise<{ result: 'already' | 'allowed'; added: number; dryRun: boolean }>;
  restrictClient(ctx: SetupCtx): Promise<{ result: 'already' | 'restricted'; dryRun: boolean }>;
  setClientLogo(ctx: SetupCtx): Promise<{ result: 'already' | 'set'; dryRun: boolean }>;
  /** `token` is the only caller value: a secret that addresses nothing. The endpoint is PassBook's own, from config. */
  ensureScim(
    token: string,
    ctx: SetupCtx,
  ): Promise<{ result: 'already' | 'created' | 'rotated'; dryRun: boolean }>;
  syncScim(ctx: SetupCtx): Promise<{ result: 'synced'; dryRun: boolean }>;
}
