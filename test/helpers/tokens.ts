import {
  type IssuedToken,
  issueToken,
  revealToken,
  sealStatement,
  type TokenPurpose,
} from '../../src/worker/platform/capability-token.ts';
import { withoutTrigger } from './triggers.ts';

/** A stored token without a real seal, for fixtures that only need the row to carry one. */
export function stubIssuedToken(token: string): IssuedToken {
  return {
    token,
    mac: `h1:${token}`,
    seal: {
      kekVersion: 1,
      iv: new Uint8Array(12),
      wrappedDek: new Uint8Array(60),
      ciphertext: new Uint8Array(16),
    },
  };
}

/** The plain link token of a pass or bundle row, as a holder sees it in the link. */
export async function linkToken(
  env: { DB: D1Database },
  row: { id: string; orgId: string; downloadToken: string },
): Promise<string> {
  return revealToken(env, 'pass', row.id, row.orgId, row.downloadToken);
}

/** A fixture token: the MAC for the token column and a writer for the sealed copy, run after the row exists. */
export async function fixtureToken(
  env: { DB: D1Database },
  id: string,
  orgId: string,
  token: string,
  purpose: TokenPurpose = 'pass',
) {
  const issued = await issueToken(env, purpose, id, orgId, token);
  if (purpose === 'apple-auth') plainAuth.set(issued.mac, token);
  return {
    mac: issued.mac,
    seal: () => sealStatement(env.DB, purpose, id, issued.mac, issued.seal).run(),
  };
}

const plainAuth = new Map<string, string>();

/** Keeps the plain device token of a row so a test can build Wallet's header without a read. */
export async function rememberAuthToken<T extends { id: string; orgId: string; authToken: string }>(
  env: { DB: D1Database },
  pass: T,
): Promise<T> {
  plainAuth.set(pass.authToken, await authTokenOf(env, pass));
  return pass;
}

/** The plain device token Wallet sends for a row: remembered by `rememberAuthToken` or the factory. */
export const deviceToken = (pass: { authToken: string }): string =>
  plainAuth.get(pass.authToken) ?? pass.authToken;

/** The plain device token of a pass row, as Wallet sends it. */
export async function authTokenOf(
  env: { DB: D1Database },
  row: { id: string; orgId: string; authToken: string },
): Promise<string> {
  return revealToken(env, 'apple-auth', row.id, row.orgId, row.authToken);
}

/** Runs `fn` with the guards that keep a plain device token out of `passes.auth_token` dropped: a pre-0065 row. */
export function asLegacyAuthTokens<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  return withoutTrigger(db, 'passes_auth_token_is_mac_update', () =>
    withoutTrigger(db, 'passes_auth_token_change_follows_generation', () =>
      withoutTrigger(db, 'pass_credential_transfer_required', () =>
        withoutTrigger(db, 'pass_credential_transfer_pending_pass_guard', fn),
      ),
    ),
  );
}

/** Runs `fn` with the guards that keep a plain token out of the token columns dropped: a pre-0059 row. */
export function asLegacyTokens<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  return withoutTrigger(db, 'passes_token_is_mac_update', () =>
    withoutTrigger(db, 'passes_token_change_moves_link', () =>
      withoutTrigger(db, 'bundles_token_is_mac_update', () =>
        withoutTrigger(db, 'pass_credential_transfer_pending_pass_guard', fn),
      ),
    ),
  );
}
