import { describe, expect, it } from 'vitest';
import { CreateApiKeySchema } from './api-keys.ts';

describe('CreateApiKeySchema', () => {
  const body = { orgId: 'o', name: 'Till', scopes: ['scans:read'] };
  it('accepts a key without the terminal scope', () => {
    expect(CreateApiKeySchema.safeParse(body).success).toBe(true);
  });
  it('accepts scans:write', () => {
    const r = CreateApiKeySchema.safeParse({ ...body, scopes: ['scans:read', 'scans:write'] });
    expect(r.success).toBe(true);
  });
});
