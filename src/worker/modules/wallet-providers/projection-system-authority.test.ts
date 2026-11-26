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
  // The version-author exemption covers system candidates of the providers the platform authors (0141, 0229),
  // and the retirement and tombstone proofs use the same predicate. A human candidate keeps the raw rule.
  // The predicate is evaluated, not matched as text.
  it('lets the version author approve a system candidate and nothing else', async () => {
    expect(await independent('google', 'system:wallet-projection')).toBe(1);
    expect(await independent('samsung', 'system:wallet-projection')).toBe(1);
    expect(await independent('apple', 'system:wallet-projection')).toBe(0);
    expect(await independent('google', 'someone-else')).toBe(0);
    expect(await independent('samsung', 'someone-else')).toBe(0);
  });

  it('the platform authors candidates for Google and Samsung, both publishable at schema 2', () => {
    expect(SYSTEM_AUTHORED_PROVIDERS).toEqual(['google', 'samsung']);
    expect(publishableSchema('google', 2)).toBe(true);
    expect(publishableSchema('samsung', 2)).toBe(true);
  });
});
