import { describe, expect, it } from 'vitest';
import { PassListQuerySchema } from './passes.ts';

describe('pass list organization scope', () => {
  it('requires an explicit orgId and parses the global selector as null', () => {
    expect(PassListQuerySchema.safeParse({}).success).toBe(false);
    expect(PassListQuerySchema.safeParse({ orgId: '' }).success).toBe(false);
    expect(PassListQuerySchema.parse({ orgId: 'org-1' }).orgId).toBe('org-1');
    expect(PassListQuerySchema.parse({ orgId: 'null' }).orgId).toBeNull();
  });
});
