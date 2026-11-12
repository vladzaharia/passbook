import { describe, expect, it } from 'vitest';
import { HolderListQuerySchema } from './holders.ts';

describe('holder list query', () => {
  it('lets an org-bound key omit the organization but rejects an empty one', () => {
    expect(HolderListQuerySchema.parse({ email: 'alex@example.com' }).orgId).toBeUndefined();
    expect(HolderListQuerySchema.safeParse({ orgId: '' }).success).toBe(false);
    expect(HolderListQuerySchema.parse({ orgId: 'org1' })).toMatchObject({
      orgId: 'org1',
      limit: 50,
    });
  });
});
