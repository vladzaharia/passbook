import {
  type IssuedToken,
  issueToken,
  revealToken,
  sealStatement,
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
) {
  const issued = await issueToken(env, 'pass', id, orgId, token);
  return {
    mac: issued.mac,
    seal: () => sealStatement(env.DB, 'pass', id, issued.mac, issued.seal).run(),
  };
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
