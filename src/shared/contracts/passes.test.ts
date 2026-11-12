import { describe, expect, it } from 'vitest';
import { PassListQuerySchema } from './passes.ts';

describe('pass list organization scope', () => {
  it('lets an org-bound key omit orgId, rejects an empty one and parses the global selector as null', () => {
    expect(PassListQuerySchema.parse({}).orgId).toBeUndefined();
    expect(PassListQuerySchema.safeParse({ orgId: '' }).success).toBe(false);
    expect(PassListQuerySchema.parse({ orgId: 'org-1' }).orgId).toBe('org-1');
    expect(PassListQuerySchema.parse({ orgId: 'null' }).orgId).toBeNull();
  });
});
