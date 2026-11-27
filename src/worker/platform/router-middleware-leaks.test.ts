import { beforeAll, describe, expect, it } from 'vitest';
import { type Api, setupApi } from '../modules/webhooks/api-test-fixtures.ts';

// Hono runs a router's `use('*', ...)` for every request under its mount path, so on a prefix several
// routers share it reaches the others' routes. Each case below needs a middleware of one router to
// stay off a route of another.
let api: Api;
let admin: Record<string, string>;
beforeAll(async () => {
  api = await setupApi();
  admin = await api.member(['org_admin']);
});

const big = (bytes: number) => ({ x: 'a'.repeat(bytes) });

describe('body caps stay on their own router', () => {
  it('the default 256 KB cap of routers sharing /api/v1/orgs does not reach brand-assets (1 MB)', async () => {
    const res = await api.call(
      'POST',
      `/api/v1/orgs/${api.rig.orgId}/brand-assets`,
      big(300_000),
      admin,
    );
    expect(res.status, res.text.slice(0, 200)).not.toBe(413);
  });

  it('the scan pairing cap of 4 KB does not reach the photo upload', async () => {
    const res = await api.call('POST', '/api/v1/scan/passes/p1/photo', big(100_000), {
      authorization: 'Bearer wls_x',
    });
    expect(res.status).not.toBe(413);
  });

  it('the pairing routes keep their 4 KB cap', async () => {
    const res = await api.call('POST', '/api/v1/scan/pair/preview', big(10_000), {
      authorization: 'Bearer wls_x',
    });
    expect(res.status).toBe(413);
  });
});

describe('routers with their own larger cap drop the 256 KB default', () => {
  it('PATCH /orgs/:id takes 300 KB and caps at 1 MB', async () => {
    const path = `/api/v1/orgs/${api.rig.orgId}`;
    expect((await api.call('PATCH', path, big(300_000), admin)).status).not.toBe(413);
    expect((await api.call('PATCH', path, big(1_100_000), admin)).status).toBe(413);
  });

  it('PUT /orgs/:id/branding/:slot takes 300 KB and caps at 1 MB', async () => {
    const path = `/api/v1/orgs/${api.rig.orgId}/branding/logo`;
    expect((await api.call('PUT', path, big(300_000), admin)).status).not.toBe(413);
    expect((await api.call('PUT', path, big(1_100_000), admin)).status).toBe(413);
  });

  it('PUT /brand/web-logo takes 300 KB and caps at 1 MB', async () => {
    const path = '/api/v1/brand/web-logo';
    expect((await api.call('PUT', path, big(300_000), admin)).status).not.toBe(413);
    expect((await api.call('PUT', path, big(1_100_000), admin)).status).toBe(413);
  });

  it('the identity provisioning route (default cap, no shared middleware) leaves its neighbours alone', async () => {
    const path = `/api/v1/orgs/${api.rig.orgId}/identities/apple`;
    expect((await api.call('POST', path, big(300_000), admin)).status).toBe(413);
    const res = await api.call(
      'POST',
      `/api/v1/orgs/${api.rig.orgId}/brand-assets`,
      big(300_000),
      admin,
    );
    expect(res.status).not.toBe(413);
  });
});
