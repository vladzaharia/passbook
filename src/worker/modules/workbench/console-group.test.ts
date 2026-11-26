import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession } from '../../../../test/helpers/index.ts';
import { BROWSER, workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
  t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'true';
});
afterAll(() => {
  t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'false';
  vi.unstubAllGlobals();
});

describe('L18: the console-group exemption (OIDC_CONSOLE_GROUP_REQUIRED on)', () => {
  it('a developer without the group works on their own sandbox: mint, the wizard and the tools', async () => {
    const d = await t.developer();
    expect(d.session.headers.cookie).toBeTruthy();
    const { token, subject } = await t.wbMint(d.browser, d.made.orgId);
    expect(subject).toBe('sandbox_key');
    const client = t.asClient(token);
    const made = await t.call('POST', '/webhook-endpoints', client, {
      url: 'https://example.com/hook',
      eventTypes: ['pass.issued'],
    });
    expect(made.status, await made.clone().text()).toBe(201);
    for (const path of ['/passes', '/webhook-endpoints', '/test-inbox', '/events'])
      expect((await t.call('GET', path, client)).status, path).toBe(200);
  });

  it('the same developer gets 403 on a regular org they belong to; with the group, 201', async () => {
    const d = await t.developer();
    const regular = await t.member();
    await t.join(d.user.id, regular.orgId, ['org_admin']);
    await expectProblem(
      await t.call('POST', '/workbench/token', d.browser, { orgId: regular.orgId }),
      403,
      'CONSOLE_ACCESS_REQUIRED',
    );
    const grouped = await makeSession(t.kit.f, {
      userId: d.user.id,
      roles: ['user', 'developer', 'console'],
    });
    const minted = await t.wbMint({ ...grouped.headers, ...BROWSER }, regular.orgId);
    expect(minted.subject).toBe('member');
    expect((await t.call('GET', '/webhook-endpoints', t.asClient(minted.token))).status).toBe(200);
  });

  it('the exemption is for your own sandbox only, and needs developer access', async () => {
    const d = await t.developer();
    const other = await t.developer();
    await expectProblem(
      await t.call('POST', '/workbench/token', other.browser, { orgId: d.made.orgId }),
      404,
      'ORG_NOT_FOUND',
    );
    // The developer role lost: the sandbox is still theirs, but the mint needs developer access.
    const plain = await makeSession(t.kit.f, { userId: d.user.id, roles: ['user'] });
    await expectProblem(
      await t.call(
        'POST',
        '/workbench/token',
        { ...plain.headers, ...BROWSER },
        { orgId: d.made.orgId },
      ),
      403,
      'DEVELOPER_ACCESS_REQUIRED',
    );
  });
});
