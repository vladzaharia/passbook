import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../platform/service-context.ts';
import { passDetails } from './email-detail.ts';

const stored: Record<string, string | null> = {
  a: JSON.stringify({ generic: { headerFields: [{ key: 'tier', label: 'Tier', value: 'Plus' }] } }),
  b: JSON.stringify({ generic: { headerFields: [{ key: 'tier', label: 'Tier', value: 'Pro' }] } }),
  gone: null,
};

vi.mock('../public/repo.ts', () => ({
  passJsonAtVersion: async (_db: unknown, id: string) => stored[id] ?? null,
}));

const ctx = { env: { DB: {} } } as unknown as ServiceContext;
const pass = (id: string) => ({ id, version: 1, displayTitle: 'Maya Chen' });

describe('passDetails', () => {
  it('names each pass by its tier, in order', async () => {
    expect(await passDetails(ctx, [pass('a'), pass('b')])).toEqual(['Tier: Plus', 'Tier: Pro']);
  });

  it('is null for a pass without a stored version', async () => {
    expect(await passDetails(ctx, [pass('gone')])).toEqual([null]);
  });
});
