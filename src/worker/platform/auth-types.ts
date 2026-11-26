// Principal and store types of the route gate; `auth.ts` re-exports them.
import type { z } from 'zod';
import type { ApiScopeSchema, Mode, RoleSchema } from '../../shared/contracts/common.ts';
import type { SignInAmr } from '../../shared/sign-in.ts';
import type { KeyCaller } from './browser-signals.ts';
import type { DeniedEvent } from './denied.ts';
import type { ScannerAuth } from './scanner-auth.ts';

export type Role = z.infer<typeof RoleSchema>;
export type Amr = SignInAmr;
export type ApiScope = z.infer<typeof ApiScopeSchema>;

export interface SessionAuth {
  kind: 'session';
  userId: string;
  sessionId: string;
  roles: Role[];
  csrfSecret: string;
  amr: Amr;
  /** An email session still inside the console grace window: when it ends (ms). Null otherwise. */
  consoleUntil?: number | null;
  /** When the sign-in was last proven (ms); null for an email link or a provider that sent no `auth_time`. */
  authTime?: number | null;
  /**
   * Set by `requireCaller`: whether the session passed the console checks. A routes that admits sessions
   * without them (`signIn: 'any'` on a scope route) serves a session where this is not `true` its own only.
   */
  consoleAccess?: boolean;
  /**
   * Stores resolve 'live'. Admin guards replace it from the x-passbook-mode header; holder routes
   * never read it (holders see all their passes).
   */
  mode: Mode;
  /** A Workbench token standing for this session in one org's Test mode (`auth-workbench.ts`). */
  workbench?: WorkbenchPin;
  /** Presented as a Workbench token (`pbtry_`): its audit rows carry `via: 'try'`. */
  via?: 'try';
}

/** The org and subject a Workbench token is bound to. Its mode is always Test. */
export interface WorkbenchPin {
  orgId: string;
  /** `sandbox_key`: the person's sandbox key. `member`: their membership in a regular org. */
  subject: 'sandbox_key' | 'member';
}

export interface ApiKeyAuth {
  kind: 'api_key';
  keyId: string;
  /** null = platform-wide key. */
  orgId: string | null;
  scopes: ApiScope[];
  /** From api_keys.mode. */
  mode: Mode;
  /** The key is limited to templates or styles (`api_key_resources`); only a `templateScoped` route admits it. */
  limited?: true;
  /** Presented as a developer try token (`pbtry_`), not the key's secret. */
  via?: 'try';
  /** For a try token: `auth_time` of the session it stands for (null: none recorded), so step-up applies to it. */
  sessionAuthTime?: number | null;
  /** For a try token: how that session signed in, so a break-glass step-up goes to break-glass. */
  sessionAmr?: Amr;
  /** The key's org is a developer org (the sandbox); absent for every other org. */
  orgKind?: 'developer';
  /** Set when a Workbench token (`/workbench/token`) stands for the key. */
  workbench?: WorkbenchPin;
}

export { SCANNER_COOKIE, SCANNER_TOKEN, type ScannerAuth } from './scanner-auth.ts';

export type AuthContext = SessionAuth | ApiKeyAuth | ScannerAuth;

/** Implemented by modules/auth. Returns null for unknown, expired, revoked or disabled-user sessions. */
export interface SessionStore {
  resolve(cookieValue: string): Promise<SessionAuth | null>;
}

/** Implemented by modules/api-keys. Hashes the presented key; returns null when invalid. */
export interface ApiKeyStore {
  /** A key limited to templates is refused (403) unless the caller passes `limited: 'ok'`. */
  resolve(
    rawKey: string,
    caller?: KeyCaller,
    options?: { limited?: 'ok' },
  ): Promise<ApiKeyAuth | null>;
}

/**
 * Implemented by modules/scan. Null for an unknown or malformed token. A known token whose scanner
 * was revoked or has expired throws a 401 with code SCANNER_REVOKED or SCANNER_EXPIRED, so the
 * device can say why. Revoking sets `revoked_at` and keeps the token columns, and expiry is
 * `expires_at` (or idle time), so the token still matches and the reason survives.
 */
export interface ScannerStore {
  resolve(
    token: string,
    transport: 'cookie' | 'bearer',
    meta?: { ipPrefix: string | null; contact?: boolean },
  ): Promise<ScannerAuth | null>;
}

/**
 * Implemented by modules/workbench. Resolves a `pbtry_` token to the sandbox key it stands for, or to a
 * Test-mode session pinned to one org. Throws 403 `WORKBENCH_TEST_ONLY` for a Live request or a route
 * the token may not call; null when the token is unknown or no longer holds.
 */
export interface WorkbenchStore {
  resolve(
    raw: string,
    caller: KeyCaller,
    options?: { limited?: 'ok' },
  ): Promise<ApiKeyAuth | SessionAuth | null>;
}

export interface AuthStores {
  sessions: SessionStore;
  apiKeys: ApiKeyStore;
  /** `pbtry_` bearers on `auth` routes; without it they go to `apiKeys`. */
  workbench?: WorkbenchStore;
  scanners: ScannerStore;
  /** Audits a refused principal. Platform never imports a module; stores.ts wires this. */
  onDenied?(event: DeniedEvent): Promise<void> | void;
}

export const denyAllStores: AuthStores = {
  sessions: { resolve: async () => null },
  apiKeys: { resolve: async () => null },
  scanners: { resolve: async () => null },
};
