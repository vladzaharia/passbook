import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { makeTenantTestApiKey } from '../passes/repo-tenant-test-fixtures.ts';
import { pdfKit } from './pdf-test-fixtures.ts';

type Started = { jobId: string; count: number };

async function setup() {
  const k = await pdfKit();
  const keyOf = async (scopes: string[], orgId: string | null = k.kit.org.id) =>
    (await makeTenantTestApiKey(k.kit.fx, { orgId, scopes })).headers;
  return { ...k, keyOf };
}

describe('bulk print with an API key', () => {
  it('starts and reads a job with passes:write and passes:read, and any key of the org reads it', async () => {
    const { kit, api, printPass, keyOf } = await setup();
    const pass = await printPass();
    const write = await keyOf(['passes:write', 'passes:read']);
    const res = await api(
      'POST',
      '/passes/bulk-print',
      { ids: [pass.id], orgId: kit.org.id },
      write,
    );
    expect(res.status).toBe(202);
    const { jobId, count } = (await res.json()) as Started;
    expect(count).toBe(1);
    const status = await api(
      'GET',
      `/passes/bulk-print/${jobId}?orgId=${kit.org.id}`,
      undefined,
      write,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: 'pending', count: 1 });
    const pdf = await api(
      'GET',
      `/passes/bulk-print/${jobId}/pdf?orgId=${kit.org.id}`,
      undefined,
      write,
    );
    expect(pdf.status).toBe(404);
    const read = await keyOf(['passes:read']);
    const sameOrg = await api(
      'GET',
      `/passes/bulk-print/${jobId}?orgId=${kit.org.id}`,
      undefined,
      read,
    );
    expect(sameOrg.status).toBe(200);
  });

  it('refuses a key without the scope', async () => {
    const { kit, api, printPass, keyOf } = await setup();
    const pass = await printPass();
    const read = await keyOf(['passes:read']);
    const start = await api(
      'POST',
      '/passes/bulk-print',
      { ids: [pass.id], orgId: kit.org.id },
      read,
    );
    expect(start.status).toBe(403);
    expect(await start.json()).toMatchObject({ code: 'MISSING_SCOPE' });
    const none = await keyOf(['templates:read']);
    const status = await api('GET', `/passes/bulk-print/x?orgId=${kit.org.id}`, undefined, none);
    expect(status.status).toBe(403);
    expect(await status.json()).toMatchObject({ code: 'MISSING_SCOPE' });
  });

  it("does not reach another org's passes or jobs", async () => {
    const { kit, api, printPass, keyOf } = await setup();
    const pass = await printPass();
    const other = await makeOrg(kit.fx);
    const foreign = await keyOf(['passes:write', 'passes:read'], other.id);
    const start = await api(
      'POST',
      '/passes/bulk-print',
      { ids: [pass.id], orgId: other.id },
      foreign,
    );
    expect(start.status).toBe(404);
    const own = await keyOf(['passes:write', 'passes:read']);
    const { jobId } = (await (
      await api('POST', '/passes/bulk-print', { ids: [pass.id], orgId: kit.org.id }, own)
    ).json()) as Started;
    const status = await api(
      'GET',
      `/passes/bulk-print/${jobId}?orgId=${other.id}`,
      undefined,
      foreign,
    );
    expect(status.status).toBe(404);
  });
});
