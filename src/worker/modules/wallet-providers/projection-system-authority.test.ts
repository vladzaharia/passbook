import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { publishableSchema } from './projection-contract.ts';
import {
  SYSTEM_AUTHORED_PROVIDERS,
  versionAuthorIndependentSql,
} from './projection-system-authority.ts';

const independent = async (provider: string, author: string) =>
  (
    await first<{ ok: number }>(
      env.DB,
      `WITH c AS (SELECT ? AS author_id, ? AS provider, 'version-author' AS version_author_id)
       SELECT ${versionAuthorIndependentSql('c', "'version-author'")} AS ok FROM c`,
      [author, provider],
    )
  )?.ok;

describe('system author exemption', () => {
  // The version-author exemption (0148) covers Google system candidates only. The Samsung retirement and
  // tombstone proofs keep the raw predicate, so a Samsung system release they would refuse must not exist.
  // The predicate is evaluated, not matched as text: appending a Samsung term would flip the Samsung row.
  it('lets the version author approve a Google system candidate and nothing else', async () => {
    expect(await independent('google', 'system:wallet-projection')).toBe(1);
    expect(await independent('samsung', 'system:wallet-projection')).toBe(0);
    expect(await independent('google', 'someone-else')).toBe(0);
  });

  it('the platform authors candidates for Google only, though Samsung schema 2 is publishable', () => {
    expect(SYSTEM_AUTHORED_PROVIDERS).toEqual(['google']);
    expect(publishableSchema('samsung', 2)).toBe(true);
  });
});
