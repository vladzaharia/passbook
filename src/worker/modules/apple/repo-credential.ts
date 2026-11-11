import type { HolderPrincipal } from '../../platform/authority-principal.ts';
import { first } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';

/** Credential captured when Wallet's serial was resolved and its token authenticated. */
export type AppleCredential = Pick<
  Pass,
  'id' | 'orgId' | 'identityId' | 'serial' | 'authToken' | 'credentialGeneration'
>;

/** Use only with a passes row aliased as p. */
export const appleCredentialSql = `p.id = ? AND p.org_id = ? AND p.identity_id = ?
  AND p.serial = ? AND p.auth_token = ? AND p.credential_generation = ?
  AND p.test_data_quarantined = 0
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = p.org_id AND o.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
    WHERE t.pass_id = p.id AND t.state = 'pending')`;

export function appleCredentialParams(pass: AppleCredential): (string | number)[] {
  return [
    pass.id,
    pass.orgId,
    pass.identityId,
    pass.serial,
    pass.authToken,
    pass.credentialGeneration,
  ];
}

export async function appleCredentialCurrent(
  db: D1Database,
  pass: AppleCredential,
): Promise<boolean> {
  if (!Number.isSafeInteger(pass.credentialGeneration) || pass.credentialGeneration <= 0)
    return false;
  return (
    (await first(
      db,
      `SELECT 1 FROM passes p WHERE ${appleCredentialSql}`,
      appleCredentialParams(pass),
    )) !== null
  );
}

/** The device's grant principal: the captured credential, proved again in SQL at commit. */
export function devicePrincipal(pass: AppleCredential): HolderPrincipal {
  return {
    kind: 'holder',
    passId: pass.id,
    proof: {
      via: 'device',
      identityId: pass.identityId,
      serial: pass.serial,
      authToken: pass.authToken,
      credentialGeneration: pass.credentialGeneration,
    },
  };
}
