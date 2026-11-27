import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { ResolvedSchema } from '../../../shared/contracts/workbench-read.ts';
import { logKit } from './request-log-test-fixtures.ts';
import { bearer, fromPage } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
});
afterAll(() => t.unstub());

const resolve = (headers: Record<string, string>, id: string) =>
  t.call(`/developer/resolve?id=${encodeURIComponent(id)}`, { headers });

describe('GET /developer/resolve', () => {
  it('names a request, a pass, a template and the sandbox, and only the caller’s own', async () => {
    const a = await t.developer();
    const b = await t.developer();
    const ray = '8a1b2c3d4e5f6a7b-LHR';
    await t.call('/passes', { headers: { ...bearer(a.key.secret), 'cf-ray': ray } });
    await t.settle();
    const row = (await t.rows(a.made.orgId))[0];
    const template = makeTemplate({ id: t.kit.f.ids.id(), orgId: a.made.orgId });
    const pass = await makePass(t.kit.f, {
      orgId: a.made.orgId,
      template: template.resolved,
      registry: template.registry,
      mode: 'test',
    });

    // The ray is found whatever case the browser sends (the search lower-cases what it classifies).
    for (const sent of [ray, ray.toLowerCase()]) {
      const found = ResolvedSchema.parse(await (await resolve(a.browser, sent)).json());
      expect(found).toMatchObject({ kind: 'request', href: `/developers/logs#${ray}` });
      expect(found.label).toBe('GET /passes, 200');
    }
    // The log detail opens by the request id too, so the link carries the id that was pasted.
    const detail = await t.call(`/developer/logs/${ray}`, { headers: a.browser });
    expect(((await detail.json()) as { id: string }).id).toBe(row?.id);
    const asPass = ResolvedSchema.parse(await (await resolve(a.browser, pass.id)).json());
    expect(asPass).toEqual({
      kind: 'pass',
      id: pass.id,
      href: `/developers/logs#path=${encodeURIComponent(`/passes/${pass.id}`)}`,
      label: pass.serial,
    });
    const asTemplate = ResolvedSchema.parse(
      await (await resolve(a.browser, template.resolved.id)).json(),
    );
    expect(asTemplate.kind).toBe('template');
    const asOrg = ResolvedSchema.parse(await (await resolve(a.browser, a.made.orgId)).json());
    expect(asOrg).toMatchObject({ kind: 'org', href: '/developers/console' });

    // Another sandbox sees none of it, by session or by try token.
    const { token } = await t.mint(b.browser);
    for (const headers of [b.browser, fromPage(b.browser, token)])
      for (const id of [ray, pass.id, template.resolved.id, a.made.orgId])
        await expectProblem(await resolve(headers, id), 404, 'RESOLVE_NOT_FOUND');
  });

  it('refuses what is not an id, a stranger and a real key', async () => {
    const a = await t.developer();
    expect((await resolve(a.browser, 'pb_test_9fK2xQ7mLp3sD8vA9fK2')).status).toBe(422);
    expect((await resolve(a.browser, 'passes')).status).toBe(422);
    const id = '0193a1b2-7c00-7000-8000-0000000000c1';
    await expectProblem(await resolve({}, id), 401, 'UNAUTHENTICATED');
    await expectProblem(await resolve(bearer(a.key.secret), id), 401, [
      'UNAUTHENTICATED',
      'INVALID_API_KEY',
    ]);
  });
});
