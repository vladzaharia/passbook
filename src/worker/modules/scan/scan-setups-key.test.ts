import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { createAuthStores } from '../../stores.ts';
import {
  admin,
  clock,
  create,
  env,
  f,
  ORIGIN,
  orgId,
  send,
  setupScannerFixture,
} from './scanners-split-test-fixtures.ts';

setupScannerFixture();

/** A call as a real, stored API key (the fixture app resolves fake keys only). */
async function asKey(
  scopes: string[],
  org: string | null,
  method: string,
  path: string,
  body?: unknown,
) {
  const { headers } = await makeApiKey(f, { orgId: org, scopes });
  const app = createApp({ stores: (e) => createAuthStores(e, clock), clock });
  return app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    },
    env,
  );
}

describe('scan-setups with an API key', () => {
  it('lists and reads setups with scan-setup:read', async () => {
    const { body } = await create({ name: 'Front door' });
    const list = await asKey(['scan-setup:read'], orgId, 'GET', '/api/v1/scan-setups');
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: { id: string }[] };
    expect(page.items.map((i) => i.id)).toContain(body.id);
    const one = await asKey(['scan-setup:read'], orgId, 'GET', `/api/v1/scan-setups/${body.id}`);
    expect(one.status).toBe(200);
  });

  it('refuses a key without the scope, for reads and writes', async () => {
    const { body } = await create();
    const other = ['scans:read', 'scanning:write'];
    await expectProblem(
      await asKey(other, orgId, 'GET', '/api/v1/scan-setups'),
      403,
      'MISSING_SCOPE',
    );
    await expectProblem(
      await asKey(other, orgId, 'GET', `/api/v1/scan-setups/${body.id}`),
      403,
      'MISSING_SCOPE',
    );
    await expectProblem(
      await asKey(['scan-setup:read'], orgId, 'PATCH', `/api/v1/scan-setups/${body.id}`, {
        name: 'x',
      }),
      403,
      'MISSING_SCOPE',
    );
  });

  it("does not reach another org's setups", async () => {
    const { body } = await create();
    const other = (await makeOrg(f)).id;
    const list = await asKey(['scan-setup:read'], other, 'GET', '/api/v1/scan-setups');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
    await expectProblem(
      await asKey(['scan-setup:read'], other, 'GET', `/api/v1/scan-setups?orgId=${orgId}`),
      403,
      'ORG_FORBIDDEN',
    );
    await expectProblem(
      await asKey(['scan-setup:read'], other, 'GET', `/api/v1/scan-setups/${body.id}`),
      404,
      'SCANNER_NOT_FOUND',
    );
  });

  it('answers 404 to a platform key on a setup by id', async () => {
    const { body } = await create();
    await expectProblem(
      await asKey(['scan-setup:read'], null, 'GET', `/api/v1/scan-setups/${body.id}`),
      404,
      'SCANNER_NOT_FOUND',
    );
  });

  it('answers 404 to a platform key on the setups list, naming an org or not', async () => {
    for (const path of ['/api/v1/scan-setups', `/api/v1/scan-setups?orgId=${orgId}`])
      await expectProblem(
        await asKey(['scan-setup:read'], null, 'GET', path),
        404,
        'ORG_NOT_FOUND',
      );
  });

  it('keeps session access', async () => {
    expect((await send('GET', '/api/v1/scan-setups', admin())).status).toBe(200);
  });
});
