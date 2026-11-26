import type { IdentityResolver } from '../identities/env-identity.ts';

export const SECOND_ID = 'identity-second';

/**
 * Serves a second global identity that signs with the platform material, as the other issuance suites do.
 * It imports types only: a `vi.mock` factory loads it while the resolver module is still being mocked.
 */
export function wrapResolver(base: IdentityResolver): IdentityResolver {
  const second = async () => ({
    ...(await base.platform()),
    id: SECOND_ID,
    orgId: null,
  });
  return {
    ...base,
    forOrg: (orgId, id, now) => (id === SECOND_ID ? second() : base.forOrg(orgId, id, now)),
    byId: (id) => (id === SECOND_ID ? second() : base.byId(id)),
    byRow: (row) => (row.id === SECOND_ID ? second() : base.byId(row.id)),
  };
}
