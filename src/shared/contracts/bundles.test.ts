import { describe, expect, it } from 'vitest';
import { BundleListQuerySchema } from './bundles.ts';

describe('bundle list query', () => {
  it('lets an org-bound key omit the organization but rejects an empty one', () => {
    expect(BundleListQuerySchema.parse({ passId: 'pass1' }).orgId).toBeUndefined();
    expect(BundleListQuerySchema.safeParse({ orgId: '' }).success).toBe(false);
    expect(BundleListQuerySchema.parse({ orgId: 'org1', passId: 'pass1' })).toMatchObject({
      orgId: 'org1',
      passId: 'pass1',
    });
  });
});
