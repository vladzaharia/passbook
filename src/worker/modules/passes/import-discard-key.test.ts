import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { HEAD, type ImportHarness, setupImportHarness } from './import-test-fixtures.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});

const keyOf = async (scopes: string[], orgId: string | null = h.kit.org.id) =>
  (await makeTenantTestApiKey(h.kit.fx, { orgId, scopes })).headers;

describe('DELETE /pass-imports/{id} with an API key', () => {
  it('discards a draft with passes:write', async () => {
    const d = await h.draft(`${HEAD}\nA,1,,D1`);
    expect((await h.api(h.key, 'DELETE', `/${d.id}`)).status).toBe(200);
    const got = await h.api(h.admin, 'GET', `/${d.id}`);
    expect(await got.json()).toMatchObject({ state: 'discarded' });
  });

  it('refuses a key without passes:write', async () => {
    const d = await h.draft(`${HEAD}\nA,1,,D2`);
    const res = await h.api(await keyOf(['passes:read']), 'DELETE', `/${d.id}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MISSING_SCOPE' });
    expect(await (await h.api(h.admin, 'GET', `/${d.id}`)).json()).toMatchObject({
      state: 'ready',
    });
  });

  it("does not reach another org's draft", async () => {
    const d = await h.draft(`${HEAD}\nA,1,,D3`);
    const other = await makeOrg(h.kit.fx);
    const res = await h.api(await keyOf(['passes:write'], other.id), 'DELETE', `/${d.id}`);
    expect(res.status).toBe(403);
    // A key of the right org but a draft id that is not there.
    const missing = await h.api(h.key, 'DELETE', '/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c');
    expect(missing.status).toBe(404);
    expect((await h.api(h.admin, 'GET', `/${d.id}`)).status).toBe(200);
  });
});
