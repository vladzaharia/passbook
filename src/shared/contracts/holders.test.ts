import { describe, expect, it } from 'vitest';
import { HolderListQuerySchema } from './holders.ts';

describe('holder list query', () => {
  it('requires an organization even when other filters are supplied', () => {
    expect(HolderListQuerySchema.safeParse({ email: 'alex@example.com' }).success).toBe(false);
    expect(HolderListQuerySchema.safeParse({ orgId: '' }).success).toBe(false);
    expect(HolderListQuerySchema.parse({ orgId: 'org1' })).toMatchObject({
      orgId: 'org1',
      limit: 50,
    });
  });
});
