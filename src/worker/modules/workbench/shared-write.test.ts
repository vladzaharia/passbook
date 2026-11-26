import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { AppError } from '../../platform/errors.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { assertSharedWrite } from '../orgs/shared-write.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const codeOf = async (p: Promise<void>) => {
  try {
    await p;
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
};

describe('shared writes: the Workbench token goes through the one Test-credential guard', () => {
  it('a token request (member or sandbox key) in a real org is MODE_LIVE_REQUIRED; a sandbox keeps it', async () => {
    const real = (await makeOrg(t.kit.f)).id;
    const sandbox = (await makeOrg(t.kit.f, { kind: 'developer' })).id;
    const ctx = createServiceContext(t.kit.env, { clock: t.kit.clock });
    const token = { ...ctx, via: 'try' as const };
    const member = { kind: 'session', mode: 'test' as const };
    expect(await codeOf(assertSharedWrite(token, member, real, 'the brand kit'))).toBe(
      'MODE_LIVE_REQUIRED',
    );
    expect(
      await codeOf(assertSharedWrite(token, { kind: 'api_key', mode: 'test' }, real, 'x')),
    ).toBe('MODE_LIVE_REQUIRED');
    expect(await codeOf(assertSharedWrite(token, member, sandbox, 'x'))).toBeNull();
    // A person in admin's Test mode is not a Test credential.
    expect(await codeOf(assertSharedWrite(ctx, member, real, 'x'))).toBeNull();
  });

  it('PATCH /brand with a member token is refused before it reaches the guard', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    await expectProblem(
      await t.call('PATCH', `/brand?orgId=${m.orgId}`, t.asClient(token), { accent: '#ff0000' }),
      403,
      'WORKBENCH_TEST_ONLY',
    );
  });
});
