import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createJobContext } from '../../platform/service-context.ts';
import { assertTenantCreateAuthority } from './create-authority.ts';

describe('a deferred pass create', () => {
  const params = {
    orgId: 'o',
    mode: 'live',
    source: 'manual',
    execution: { kind: 'deferred', starter: {} },
  } as never;
  it('is refused for a job context narrowed to some purposes', async () => {
    const narrowed = createJobContext(env, 'x', {
      allowedPurposes: ['org_mode.job.wallet.record'],
    });
    await expect(assertTenantCreateAuthority(narrowed, params)).rejects.toMatchObject({
      status: 403,
    });
  });
});
