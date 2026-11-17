import { stmt } from '../../platform/db.ts';
import { orgForPassStmt } from '../orgs/repo.ts';
import type { Pass } from './repo-map.ts';
import { mapPassOrg, type PassOrg } from './repo-read-issuance.ts';
import { mapPublishRemoval, publishRemovalStmt } from './repo-write-publish-snapshot.ts';

/** What a publish attempt reads about a pass it has just loaded, in one D1 round trip. */
export interface PublishReads {
  removal: ReturnType<typeof mapPublishRemoval>;
  org: PassOrg | null;
  personalized: boolean;
  previousJson: string | null;
}

export async function readPublishBundle(
  db: D1Database,
  pass: Pass,
  requireRemovalClaim: boolean,
): Promise<PublishReads> {
  const [removal, org, personalization, version] = await db.batch([
    publishRemovalStmt(db, pass, requireRemovalClaim),
    orgForPassStmt(db, pass.orgId),
    stmt(db, 'SELECT pass_id FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    stmt(
      db,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    ),
  ]);
  const first = <T>(r: D1Result | undefined) => (r?.results?.[0] as T | undefined) ?? null;
  return {
    removal: mapPublishRemoval(pass, first(removal)),
    org: mapPassOrg(first(org)),
    personalized: first(personalization) !== null,
    previousJson: first<{ pass_json: string | null }>(version)?.pass_json ?? null,
  };
}
