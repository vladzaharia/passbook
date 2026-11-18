import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import {
  CapturedEmailDetailSchema,
  CapturedEmailListSchema,
} from '../../../shared/contracts/index.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { captureInboxPass, inboxApp } from './test-tenant-fixtures.ts';

type Headers = Record<string, string>;
let kit: Kit;
let app: ReturnType<typeof inboxApp>;
let otherOrgId: string;
let testKey: Headers;
let liveKey: Headers;
let otherOrgTestKey: Headers;
let platformTestKey: Headers;
let noScopeTestKey: Headers;
let mineId: string;
let theirsId: string;

const get = (path: string, headers: Headers, orgId = kit.org.id) => {
  const sep = path.includes('?') ? '&' : '?';
  return app.request(`https://wallet.test/api/v1${path}${sep}orgId=${orgId}`, { headers }, kit.env);
};

beforeAll(async () => {
  kit = await setupKit();
  app = inboxApp(kit);
  otherOrgId = (await makeOrg(kit.fx, { name: 'Other Org' })).id;
  const key = async (orgId: string | null, mode: 'live' | 'test', scopes = ['passes:read']) =>
    (await makeApiKey(kit.fx, { orgId, mode, scopes })).headers;
  testKey = await key(kit.org.id, 'test');
  liveKey = await key(kit.org.id, 'live');
  otherOrgTestKey = await key(otherOrgId, 'test');
  platformTestKey = await key(null, 'test');
  noScopeTestKey = await key(kit.org.id, 'test', ['templates:read']);
  mineId = (await captureInboxPass(kit)).id;
  theirsId = (await captureInboxPass(kit, otherOrgId)).id;
});

describe('test inbox with an API key', () => {
  it('a test key lists and reads its own organization test mail', async () => {
    const list = CapturedEmailListSchema.parse(await (await get('/test-inbox', testKey)).json());
    expect(list.items.map((i) => i.id)).toContain(mineId);
    expect(list.items.every((i) => i.orgId === kit.org.id)).toBe(true);
    const res = await get(`/test-inbox/${mineId}`, testKey);
    expect(res.status).toBe(200);
    expect(CapturedEmailDetailSchema.parse(await res.json()).html.length).toBeGreaterThan(0);
  });

  it('a live key is refused, even with the right scope and org', async () => {
    await expectProblem(await get('/test-inbox', liveKey), 403, 'TEST_KEY_REQUIRED');
    await expectProblem(await get(`/test-inbox/${mineId}`, liveKey), 403, 'TEST_KEY_REQUIRED');
  });

  it('another organization is refused in both directions', async () => {
    await expectProblem(await get('/test-inbox', testKey, otherOrgId), 403, 'FORBIDDEN');
    await expectProblem(await get('/test-inbox', otherOrgTestKey), 403, 'FORBIDDEN');
    await expectProblem(
      await get(`/test-inbox/${theirsId}`, testKey),
      404,
      'CAPTURED_EMAIL_NOT_FOUND',
    );
    await expectProblem(await get('/test-inbox', platformTestKey), 403, 'FORBIDDEN');
  });

  it('a key without passes:read is refused', async () => {
    await expectProblem(await get('/test-inbox', noScopeTestKey), 403, 'MISSING_SCOPE');
  });

  it('a key cannot use the preview frame or forward mail', async () => {
    await expectProblem(
      await get(`/test-inbox/${mineId}/html?mode=test`, testKey),
      403,
      'SESSION_REQUIRED',
    );
    const send = await app.request(
      `https://wallet.test/api/v1/test-inbox/${mineId}/send-to-me?orgId=${kit.org.id}`,
      { method: 'POST', headers: testKey },
      kit.env,
    );
    await expectProblem(send, 403, 'SESSION_REQUIRED');
  });
});
