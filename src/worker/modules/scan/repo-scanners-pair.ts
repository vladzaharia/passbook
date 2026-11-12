import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { gt, inList, maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { first } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { TenantPassWrite } from '../passes/http.ts';

type Db = D1Database;

/** Pairing administration is only available to the captured tenant session. */
export function requirePairingAuthority(
  authority: TenantPassWrite | null | undefined,
  userId: string,
  orgId: string,
): asserts authority is Extract<TenantPassWrite, { kind: 'session' }> {
  if (
    authority?.kind !== 'session' ||
    authority.userId !== userId ||
    authority.orgId !== orgId ||
    authority.capability !== 'scanning:manage'
  )
    throw new ForbiddenError();
}

const TOKEN_CLEARED = {
  token_prefix: null,
  token_hash: null,
  csrf_secret: null,
  paired_at: null,
  paired_label: null,
  expires_at: null,
  staff_id: null,
  staff_since: null,
  staff_seen_at: null,
} as const;

/**
 * A fresh code replaces any live one. On a revoked or expired scanner the code starts over: the old
 * token is cleared and the revocation lifted in the same write, so the code redeems an unpaired
 * scanner and the old device cannot come back.
 */
export const addPairCode = (
  g: Grant,
  id: string,
  hash: string,
  expiresAt: number,
  userId: string,
  now: number,
  restart: boolean,
): GrantedStatement =>
  g.update('scanners', {
    set: {
      pair_code_hash: hash,
      pair_expires_at: expiresAt,
      pair_created_by: userId,
      updated_at: maxNow(now),
      ...(restart ? { ...TOKEN_CLEARED, revoked_at: null } : {}),
    },
    where: { id, kind: inList(['device', 'display']) },
    require: 'one',
  });

export interface Credential {
  tokenPrefix: string;
  tokenHash: string;
  /** Null for a terminal. */
  csrfSecret: string | null;
  label: string | null;
  expiresAt: number;
  now: number;
}

const installed = (c: Credential): Record<string, SetValue> => ({
  token_prefix: c.tokenPrefix,
  token_hash: c.tokenHash,
  csrf_secret: c.csrfSecret,
  paired_at: c.now,
  paired_label: c.label,
  expires_at: c.expiresAt,
  last_seen_at: c.now,
  revoked_at: null,
  updated_at: maxNow(c.now),
  staff_id: null,
  staff_since: null,
  staff_seen_at: null,
  pair_code_hash: null,
});

/** Console issuance (pair here, replace a terminal token): the scanner is of this kind. */
export const addAdminCredential = (
  g: Grant,
  id: string,
  kind: string,
  c: Credential,
): GrantedStatement =>
  g.update('scanners', { set: installed(c), where: { id, kind }, require: 'one' });

/** An issued code authorizes redemption without a session: only while the code is live. */
export const addCodeCredential = (
  g: Grant,
  id: string,
  codeHash: string,
  c: Credential,
): GrantedStatement =>
  g.update('scanners', {
    set: installed(c),
    where: {
      id,
      kind: inList(['device', 'display']),
      pair_code_hash: codeHash,
      pair_expires_at: gt(c.now),
    },
    require: 'one',
  });

/** Clears the token of a device that unpaired itself. Matches only the token it presented. */
export const addTokenClear = (
  g: Grant,
  id: string,
  tokenHash: string,
  now: number,
): GrantedStatement =>
  g.update('scanners', {
    set: { ...TOKEN_CLEARED, updated_at: maxNow(now) },
    where: { id, token_hash: tokenHash, kind: inList(['device', 'display']) },
    require: 'one',
  });

export interface PairTarget {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  orgName: string;
  credentialEpoch: number;
}

/** A live code of an active org. The same row answers preview and pair. */
export const findByPairCode = (db: Db, hash: string, now: number): Promise<PairTarget | null> =>
  first<{
    id: string;
    org_id: string;
    mode: Mode;
    name: string;
    org_name: string;
    credential_epoch: number;
  }>(
    db,
    `SELECT s.id, s.org_id, s.mode, s.name, o.name AS org_name, s.credential_epoch
     FROM scanners s JOIN orgs o ON o.id = s.org_id AND o.status = 'active'
     WHERE s.pair_code_hash = ? AND s.pair_expires_at > ? AND s.kind IN ('device','display') AND NOT EXISTS (SELECT 1 FROM scanner_setups m WHERE m.scanner_id=s.id AND m.admin_session=1)`,
    [hash, now],
  ).then((r) =>
    r
      ? {
          id: r.id,
          orgId: r.org_id,
          mode: r.mode,
          name: r.name,
          orgName: r.org_name,
          credentialEpoch: r.credential_epoch,
        }
      : null,
  );
