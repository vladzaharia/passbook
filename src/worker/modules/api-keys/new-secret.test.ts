import { describe, expect, it } from 'vitest';
import { apiKeyPrefixOf } from '../../platform/api-key-token.ts';
import { createIds } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { newSecret } from './service-create.ts';

describe('newSecret', () => {
  it('always yields a key that parses back to its own prefix, whatever random characters it holds', async () => {
    const ctx = { ids: createIds({ now: () => 0 }) } as unknown as ServiceContext;
    let withUnderscore = 0;
    for (let i = 0; i < 2000; i++) {
      for (const kind of ['service', 'personal', 'platform'] as const) {
        const made = await newSecret(ctx, kind, i % 2 ? 'live' : 'test');
        if (made.prefix.includes('_')) withUnderscore++;
        expect(apiKeyPrefixOf(made.secret), made.secret).toBe(made.prefix);
      }
    }
    expect(withUnderscore).toBeGreaterThan(0);
  });
});
