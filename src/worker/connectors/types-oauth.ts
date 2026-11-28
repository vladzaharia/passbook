import type { Json } from '../../shared/contracts/common.ts';

/** Stored as credential kind `connector`; the core refreshes it before `expiresAt`. */
export interface OAuthTokenEnvelope {
  type: 'oauth';
  access: string;
  refresh: string | null;
  expiresAt: number | null;
}

/**
 * Endpoints for `auth: 'oauth2'`. The core owns the flow (state, PKCE, callback, refresh, revoke);
 * the client id and secret are Worker secrets named for the connector type.
 */
export interface ConnectorOAuth<C> {
  authorizeUrl(config: C): string;
  tokenUrl(config: C): string;
  revokeUrl?(config: C): string;
  scopes(config: C): string[];
  /** For a vendor whose token response is not the standard shape. */
  parseToken?(body: Json, now: number): OAuthTokenEnvelope;
}
