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
  // The metadata read of the second identity: the platform's certificate, as the key read signs with it.
  const peeked = async () => {
    const platform = await base.platform();
    return {
      id: SECOND_ID,
      certificate: platform.material.certificate,
      passTypeIdentifier: platform.passTypeIdentifier,
      teamIdentifier: platform.teamIdentifier,
    };
  };
  return {
    ...base,
    // The base answers (and refuses) from the database row; the certificate is the platform's.
    peekForOrg: async (orgId, id, now) => {
      const found = await base.peekForOrg?.(orgId, id, now);
      return found?.id === SECOND_ID ? peeked() : (found as never);
    },
    peekById: async (id) => {
      const found = await base.peekById?.(id);
      return found?.id === SECOND_ID ? peeked() : (found as never);
    },
    forOrg: (orgId, id, now) => (id === SECOND_ID ? second() : base.forOrg(orgId, id, now)),
    byId: (id) => (id === SECOND_ID ? second() : base.byId(id)),
    byRow: (row) => (row.id === SECOND_ID ? second() : base.byId(row.id)),
  };
}
