import type { Clock } from '../../platform/clock.ts';
import { first } from '../../platform/db.ts';
import { holderReissueCurrentSql } from '../holders/repo.ts';
import type { TenantPassWrite } from './http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from './repo-authority.ts';
import type { Pass } from './repo-map.ts';

type PassDetailState = {
  state: 'pending' | 'current' | 'stale' | 'forbidden';
  reissue_required: number;
};

/** Read the current incarnation and each authority in the same database snapshot. */
export function passDetailReadState(
  db: D1Database,
  pass: Pass,
  authorities: TenantPassWrite[],
  clock: Clock,
): Promise<PassDetailState | null> {
  return first<PassDetailState>(
    db,
    `SELECT CASE
       ${authorities.map((item) => `WHEN NOT (${tenantPassAuthoritySql(item, 'p')}) THEN 'forbidden'`).join('\n')}
       WHEN EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending') THEN 'pending'
       WHEN p.credential_generation = ? AND p.lifecycle_generation = ?
         AND p.link_generation = ? AND p.version = ? AND p.revision = ?
         AND p.serial = ? AND p.auth_token = ? AND p.download_token = ?
         AND p.holder_email IS ? AND p.owner_user_id IS ? AND p.status = ? AND p.removed_at IS ?
         AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
           WHERE t.pass_id = p.id AND t.state = 'pending') THEN 'current'
       ELSE 'stale'
     END AS state, ${holderReissueCurrentSql('p')} AS reissue_required
     FROM passes p WHERE p.id = ? AND p.org_id = ? AND p.mode = ?
       AND p.deleted_at IS NULL AND p.test_data_quarantined = 0`,
    [
      ...authorities.flatMap((item) => tenantPassAuthorityParams(item, clock.now())),
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      pass.linkGeneration,
      pass.version,
      pass.revision,
      pass.serial,
      pass.authToken,
      pass.downloadToken,
      pass.holderEmail,
      pass.ownerUserId,
      pass.status,
      pass.removedAt,
      pass.id,
      pass.orgId,
      pass.mode,
    ],
  );
}
