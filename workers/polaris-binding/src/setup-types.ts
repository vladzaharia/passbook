import type { WriteCtx } from './types.ts';

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
    restricted: boolean;
    /** Placed roles whose group the client does not allow. */
    missingRoles: string[];
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
 * token. Kept apart from `IdpRpc` in types.ts until the main Worker's client and fake model them (AS-2).
 */
export interface SetupRpc {
  /** Reads the PassBook client, its SCIM connection and the unplaced role groups. Hashes are SHA-256 hex of candidate SCIM tokens. */
  setupStatus(opts?: { tokenHashes?: string[] }): Promise<SetupStatus>;
  placeRoleGroups(ctx: WriteCtx): Promise<PlaceResult>;
  allowClientGroups(
    ctx: WriteCtx,
  ): Promise<{ result: 'already' | 'allowed'; added: number; dryRun: boolean }>;
  restrictClient(ctx: WriteCtx): Promise<{ result: 'already' | 'restricted'; dryRun: boolean }>;
  setClientLogo(ctx: WriteCtx): Promise<{ result: 'already' | 'set'; dryRun: boolean }>;
  /** `token` is the only caller value: a secret that addresses nothing. The endpoint is PassBook's own, from config. */
  ensureScim(
    token: string,
    ctx: WriteCtx,
  ): Promise<{ result: 'already' | 'created' | 'rotated'; dryRun: boolean }>;
  syncScim(ctx: WriteCtx): Promise<{ result: 'synced'; dryRun: boolean }>;
}
