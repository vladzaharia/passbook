import { type IssuedToken, revealToken } from '../../src/worker/platform/capability-token.ts';

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
