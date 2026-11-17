import { first } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { audited, sessionGrant } from './repo-admin-grant.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

type Db = D1Database;

/** Keep the session secret in direct scalar binds, not in packed output JSON. */
export async function consoleFeedAuthorityCurrent(
  db: Db,
  guard: OutputPredicate,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  const result = await first<{ authorized: number; keyset_current: number }>(
    db,
    `SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END AS authorized,
      CASE WHEN ${credentialRefKeysetSql} THEN 1 ELSE 0 END AS keyset_current`,
    [...guard.params, credentialKeysetCommitment],
  );
  if (result?.keyset_current !== 1)
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  return result.authorized === 1;
}

/** Audit an export in a grant, so it commits only while the tenant session and membership hold. */
export async function auditScanExport(
  ctx: ServiceContext,
  authority: Extract<TenantPassWrite, { kind: 'session' }>,
  detail: { from: number; to: number; rows: number },
): Promise<void> {
  const g = sessionGrant(ctx, 'org_mode.scan.export', authority);
  audited(g, ctx, {
    orgId: authority.orgId,
    actorType: 'user',
    actorId: authority.userId,
    action: 'scan.export',
    targetType: 'org',
    targetId: authority.orgId,
    detail,
  });
  await g.commit();
}
