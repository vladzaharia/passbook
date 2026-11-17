import { stmt } from '../../platform/db.ts';
import { type IdentityRow, identityRowStmt } from '../identities/repo.ts';
import { orgForPassStmt } from '../orgs/repo.ts';
import { type BuildInputs, buildInputStmts, buildInputsFromResults } from './build-reads.ts';
import type { Pass } from './repo-map.ts';
import { mapPassOrg, type PassOrg } from './repo-read-issuance.ts';
import { mapPublishRemoval, publishRemovalStmt } from './repo-write-publish-snapshot.ts';

/** What a publish attempt reads about a pass it has just loaded, in one D1 round trip. */
export interface PublishReads {
  removal: ReturnType<typeof mapPublishRemoval>;
  org: PassOrg | null;
  personalized: boolean;
  previousJson: string | null;
  identityRow: IdentityRow | null;
  /** Build inputs for the pass's own template id. */
  inputs: BuildInputs;
  /** Results of the caller's `extra` statements, in order. */
  extra: D1Result[];
}

export async function readPublishBundle(
  db: D1Database,
  pass: Pass,
  requireRemovalClaim: boolean,
  extra: D1PreparedStatement[] = [],
): Promise<PublishReads> {
  const inputReq = { passId: pass.id, orgId: pass.orgId };
  const [removal, org, personalization, version, identity, ...rest] = await db.batch([
    publishRemovalStmt(db, pass, requireRemovalClaim),
    orgForPassStmt(db, pass.orgId),
    stmt(db, 'SELECT pass_id FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    stmt(
      db,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    ),
    identityRowStmt(db, pass.identityId),
    ...buildInputStmts(db, inputReq, pass.templateId),
    ...extra,
  ]);
  const inputResults = rest.slice(0, rest.length - extra.length);
  const first = <T>(r: D1Result | undefined) => (r?.results?.[0] as T | undefined) ?? null;
  return {
    removal: mapPublishRemoval(pass, first(removal)),
    org: mapPassOrg(first(org)),
    personalized: first(personalization) !== null,
    previousJson: first<{ pass_json: string | null }>(version)?.pass_json ?? null,
    identityRow: first<IdentityRow>(identity),
    inputs: buildInputsFromResults({}, inputResults),
    extra: rest.slice(rest.length - extra.length),
  };
}
