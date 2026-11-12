import { beforeAll, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

let auth: TenantTestAuth;
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit({ approvedReleases: false });
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
}, 60_000);

it('answers 409 TEMPLATE_RELEASE_REQUIRED with guidance and creates nothing', async () => {
  const key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
  const res = await app.request(
    'https://wallet.test/api/v1/passes',
    {
      method: 'POST',
      headers: { ...key, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        templateId: kit.template.id,
        input: { memberName: 'Baseline' },
      }),
    },
    kit.env,
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { code: string };
  expect(body.code).toBe('TEMPLATE_RELEASE_REQUIRED');
  expect(JSON.stringify(body)).toContain('Approve and publish a release');
  const count = await kit.env.DB.prepare('SELECT COUNT(*) AS n FROM passes').first<{ n: number }>();
  expect(count?.n).toBe(0);
});
