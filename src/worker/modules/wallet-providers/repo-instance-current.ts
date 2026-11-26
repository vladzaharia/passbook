// PE5a: "is this operation still current" on epochs (provider-epochs-design.md §2.2), replacing the W1/W2 fences
// of walletInstanceOperationCurrentSql. Two forms of one rule:
//  - walletOpCurrentSql carries no tenant column, so it fits a grant part (a part may name org_id and mode only as
//    {org} and {mode}) and the value `is_current` of a settle, which records a result even when it is stale.
//  - walletOpCurrentCheck is the grant check (reason `stale`): the same rule, the tenant of the actor row, the
//    org status and the projection head.
import type { Check } from '../../platform/authority-checks.ts';
import { hasCredentialSql } from './account-presence.ts';

function alias(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new Error('Invalid trusted SQL alias');
  return value;
}

/**
 * A balanced AND tree. SQLite parses `a AND b AND c` left-deep, so a long conjunction of terms (each of which may hold
 * a subquery whose own height adds up) reaches D1's expression depth limit of 100 long before it is complicated.
 */
export function allOf(terms: readonly string[]): string {
  if (terms.length === 1) return terms[0] ?? '1';
  const mid = terms.length >> 1;
  return `(${allOf(terms.slice(0, mid))} AND ${allOf(terms.slice(mid))})`;
}

/** Every earlier generation of the pass has settled its retirement (the single settle definition, D5). */
// Settledness is the stored column (D5, 0148).
export const previousGenerationsSettledSql = (i: string) =>
  `NOT EXISTS (SELECT 1 FROM wallet_provider_instances previous WHERE previous.pass_id = ${i}.pass_id
    AND previous.credential_generation < ${i}.credential_generation AND previous.retirement_settled_at IS NULL)`;

/**
 * The account's credential is of the identity the instance was created under (D6): a rotation keeps it, a change
 * loses it. An enrolment's identity cannot change while an instance is open (wallet_enrolments_identity_in_use),
 * and a Samsung enrolment's is the partner alone while a card's identity adds its card id, so the hashes only
 * compare for Google; the runtime still checks the card identity against the decrypted credential.
 */
export const revokeIdentitySql = (i: string) =>
  `EXISTS (SELECT 1 FROM wallet_provider_accounts account
    LEFT JOIN wallet_provider_credentials credential ON credential.id = account.credential_id
    WHERE ${allOf([
      `account.id = ${i}.account_id`,
      'account.revoked_at IS NULL',
      `(COALESCE(credential.identity_hash, account.identity_hash) = (SELECT original.provider_identity_hash
        FROM template_releases rel JOIN template_candidates original ON original.id = rel.candidate_id
        WHERE rel.id = ${i}.identity_projection_release_id)
        OR (account.provider = 'samsung' AND account.credential_source_id IS NOT NULL))`,
    ])})`;

/**
 * The desired-op CAS plus the epoch fences. An upsert pins the pass row_version, its generations and the account
 * epoch. A revoke pins no pass content and no account epoch (D6): it needs the instance lineage and a credential
 * whose identity is the one the instance was created under.
 */
export function walletOpCurrentSql(instanceAlias: string, operationAlias: string): string {
  const i = alias(instanceAlias);
  const op = alias(operationAlias);
  const upsert = allOf([
    `${op}.kind = 'upsert'`,
    `${i}.lifecycle = 'active'`,
    `${i}.retirement_requested_at IS NULL`,
    `${op}.pass_row_version IS NOT NULL`,
    `p.row_version = ${op}.pass_row_version`,
    `p.lifecycle_generation = ${op}.lifecycle_generation`,
    `p.credential_generation = ${i}.credential_generation`,
    `p.status = 'active'`,
    'p.deleted_at IS NULL',
    'p.removed_at IS NULL',
    'p.test_data_quarantined = 0',
    `NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
      WHERE transfer.pass_id = p.id AND transfer.state = 'pending')`,
    `EXISTS (SELECT 1 FROM wallet_provider_accounts account WHERE ${allOf([
      `account.id = ${i}.account_id`,
      `account.authority_epoch = ${op}.account_epoch`,
      hasCredentialSql('account'),
      'account.revoked_at IS NULL',
    ])})`,
  ]);
  const revoke = allOf([
    `${op}.kind = 'revoke'`,
    `${i}.lifecycle IN ('active', 'revoking')`,
    `${i}.credential_generation <= p.credential_generation`,
    `${op}.projection_release_id = ${i}.identity_projection_release_id`,
    revokeIdentitySql(i),
  ]);
  return allOf([
    `${op}.instance_id = ${i}.id`,
    `${op}.id = ${i}.desired_operation_id`,
    `${op}.version = ${i}.desired_version`,
    `${op}.credential_keyset_commitment = ${i}.credential_keyset_commitment`,
    `EXISTS (SELECT 1 FROM passes p WHERE p.id = ${i}.pass_id AND (${upsert} OR ${revoke}))`,
    // A sibling of the pass term, not inside it: the settle proof is the deepest subquery here.
    `(${op}.kind = 'revoke' OR ${previousGenerationsSettledSql(i)})`,
  ]);
}

/**
 * An upsert is bound to the current head of its projection: the release is the newest of its template, mode and
 * provider, and was approved for the pass's template version, source release and the account's epoch. The release
 * itself is proven once, at insert (D8). A revoke has no projection to follow.
 */
export function walletOpHeadSql(
  instanceAlias: string,
  operationAlias: string,
  orgSql: string,
  modeSql: string,
): string {
  const i = alias(instanceAlias);
  const op = alias(operationAlias);
  const head = allOf([
    `pr.id = ${op}.projection_release_id`,
    `pr.org_id = ${orgSql}`,
    `pr.mode = ${modeSql}`,
    `pr.provider = ${i}.provider`,
    'pr.template_id = pass.template_id',
    'pr.version = pass.template_version',
    'pc.source_release_id IS pass.release_id',
    `pc.provider_account_id = ${i}.account_id`,
    'pc.provider_account_epoch = account.authority_epoch',
    `NOT EXISTS (SELECT 1 FROM template_releases newer WHERE ${allOf([
      'newer.template_id = pr.template_id',
      'newer.org_id = pr.org_id',
      'newer.mode = pr.mode',
      'newer.provider = pr.provider',
      'newer.generation > pr.generation',
    ])})`,
  ]);
  return `(${op}.kind = 'revoke' OR EXISTS (SELECT 1 FROM template_releases pr
    JOIN template_candidates pc ON pc.id = pr.candidate_id JOIN passes pass ON pass.id = ${i}.pass_id
    JOIN wallet_provider_accounts account ON account.id = ${i}.account_id WHERE ${head}))`;
}

/** The same rule as a read: the owning org must be active for an upsert (a grant carries this in the actor row). */
export function walletOpReadCurrentSql(instanceAlias: string, operationAlias: string): string {
  const i = alias(instanceAlias);
  const op = alias(operationAlias);
  return allOf([
    walletOpCurrentSql(i, op),
    walletOpHeadSql(i, op, `${i}.org_id`, `${i}.mode`),
    `(${op}.kind = 'revoke' OR EXISTS (SELECT 1 FROM orgs owner WHERE owner.id = ${i}.org_id AND owner.status = 'active'))`,
  ]);
}

/** The grant check of work on one operation: it is the instance's desired one and every epoch fence holds. */
export function walletOpCurrentCheck(instanceId: string, version: number): Check {
  return {
    reason: 'stale',
    ok: (b) => `EXISTS (SELECT 1 FROM wallet_provider_instances i
      JOIN wallet_provider_instance_operations op ON op.instance_id = i.id
      WHERE ${allOf([
        `i.id = ${b.bind(instanceId)}`,
        `op.version = ${b.bind(version)}`,
        'i.org_id = a.org_id',
        'i.mode = a.mode',
        walletOpCurrentSql('i', 'op'),
        walletOpHeadSql('i', 'op', 'a.org_id', 'a.mode'),
      ])})`,
  };
}

/** The projection release is the current head for the instance (an upsert about to be queued). */
export function projectionHeadCheck(instanceId: string, projectionReleaseId: string): Check {
  return {
    reason: 'release',
    ok: (b) => `EXISTS (SELECT 1 FROM wallet_provider_instances i
      JOIN (SELECT ${b.bind(projectionReleaseId)} AS projection_release_id, 'upsert' AS kind) op ON 1 = 1
      WHERE i.id = ${b.bind(instanceId)} AND i.org_id = a.org_id AND i.mode = a.mode
        AND ${walletOpHeadSql('i', 'op', 'a.org_id', 'a.mode')})`,
  };
}

/** The account's authority epoch is still the one the caller captured, and the account is usable. */
export function accountEpochCheck(accountId: string, epoch: number): Check {
  return {
    reason: 'config',
    ok: (
      b,
    ) => `EXISTS (SELECT 1 FROM wallet_provider_accounts account WHERE account.id = ${b.bind(accountId)}
      AND account.org_id = a.org_id AND account.mode = a.mode AND account.authority_epoch = ${b.bind(epoch)}
      AND ${hasCredentialSql('account')} AND account.revoked_at IS NULL)`,
  };
}

/** The instance exists in the actor's tenant (lineage). */
export function instanceCheck(instanceId: string, desiredVersion?: number): Check {
  return {
    reason: desiredVersion === undefined ? 'lineage' : 'stale',
    ok: (b) => `EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = ${b.bind(instanceId)}
      AND i.org_id = a.org_id AND i.mode = a.mode${
        desiredVersion === undefined ? '' : ` AND i.desired_version = ${b.bind(desiredVersion)}`
      })`,
  };
}

/** The operation is a revoke: the always-run grants serve revokes only (an upsert never runs for a closed org). */
export function revokeKindCheck(instanceId: string, version: number): Check {
  return {
    reason: 'lineage',
    ok: (b) => `EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
      WHERE op.instance_id = ${b.bind(instanceId)} AND op.version = ${b.bind(version)} AND op.kind = 'revoke')`,
  };
}
