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
