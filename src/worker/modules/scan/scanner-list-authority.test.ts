import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { listScanners } from './scanner-views.ts';

// A denial happens before any query, so the context is never touched.
const ctx = {} as ServiceContext;
const query = { orgId: 'org-a', limit: 10 } as Parameters<typeof listScanners>[2];
const authority = (over: Record<string, unknown>) =>
  ({
    kind: 'session',
    capability: 'scanning:read',
    mode: 'live',
    orgId: 'org-a',
    ...over,
  }) as unknown as TenantPassWrite;

describe('listScanners honours the captured authority', () => {
  it.each([
    ['another org', { orgId: 'org-b' }],
    ['another mode', { mode: 'test' }],
    ['a weaker capability', { capability: 'scanning:manage' }],
    ['a non-session authority', { kind: 'job' }],
  ])('refuses %s', async (_name, over) => {
    await expect(listScanners(ctx, 'live', query, authority(over))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses a query without an org', async () => {
    await expect(
      listScanners(ctx, 'live', { limit: 10 } as typeof query, authority({})),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
