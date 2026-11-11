import { describe, expect, it } from 'vitest';
import { BundleListQuerySchema } from './bundles.ts';

describe('bundle list query', () => {
  it('requires an organization even when filtering by pass', () => {
    expect(BundleListQuerySchema.safeParse({ passId: 'pass1' }).success).toBe(false);
    expect(BundleListQuerySchema.safeParse({ orgId: '' }).success).toBe(false);
    expect(BundleListQuerySchema.parse({ orgId: 'org1', passId: 'pass1' })).toMatchObject({
      orgId: 'org1',
      passId: 'pass1',
    });
  });
});
