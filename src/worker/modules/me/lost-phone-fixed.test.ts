import { describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { CredentialTransferReissueRequired } from '../passes/credential-transfer.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { lostMyPhone } from './service-help.ts';

vi.mock('../holders/service-rotate.ts', () => ({
  rotateOwnPassCredentials: async () => {
    throw new CredentialTransferReissueRequired('c'.repeat(64));
  },
}));

describe('I lost my phone on a pass whose credential cannot change', () => {
  it('answers 409 with one sentence naming the org', async () => {
    const kit = await setupKit();
    kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
    const user = await makeUser(kit.fx);
    const pass = await kit.pass({ holderEmail: user.primaryEmail });
    const session = await makeSession(kit.fx, { userId: user.id, amr: 'magic_link' });
    const sid = await sha256Hex(session.cookieValue);
    const error = await lostMyPhone(kit.ctx, user.id, sid, pass.id).catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 409,
      code: 'PASS_CREDENTIAL_FIXED',
      message: expect.stringMatching(/^This pass's code can't change\. Ask .+\.$/),
    });
    void expectProblem;
  });
});
