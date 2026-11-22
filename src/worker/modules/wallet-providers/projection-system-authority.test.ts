import { describe, expect, it } from 'vitest';
import { publishableSchema } from './projection-contract.ts';
import { versionAuthorIndependentSql } from './projection-system-authority.ts';

describe('system author exemption', () => {
  // The version-author exemption (0148) covers Google system candidates only. The Samsung retirement and
  // tombstone proofs keep the raw predicate, so a Samsung system release they would refuse must not exist.
  // If this fails, make those proofs accept the exemption (or keep Samsung schema 2 closed) first.
  it('is Google-only while Samsung schema 2 is unpublishable', () => {
    expect(publishableSchema('samsung', 2)).toBe(false);
    expect(versionAuthorIndependentSql('c', 'r')).toContain("c.provider = 'google'");
  });
});
