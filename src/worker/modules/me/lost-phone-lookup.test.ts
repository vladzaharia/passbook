import { describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import type { Job } from '../../jobs/types.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { codeOf, key, setupScanKit } from '../scan/test-kit.ts';

async function lostPhone(barcode?: string) {
  const kit = await setupScanKit();
  kit.env.JOBS = { send: vi.fn(async (_: Job) => {}), sendBatch: vi.fn() } as unknown as Queue;
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
  const templateId = await kit.scanTemplate(
    'Lookup',
    {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      lookup: { input: 'memberNo' },
    },
    barcode ? { barcode } : {},
  );
  const user = await makeUser(kit.fx);
  const pass = await kit.scanPass(
    templateId,
    { memberNo: 'M-1001' },
    { holderEmail: user.primaryEmail },
  );
  const mine = await makeSession(kit.fx, { userId: user.id, amr: 'magic_link' });
  const app = createApp({
    clock: kit.clock,
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
  });
  const lost = () =>
    Promise.resolve(
      app.request(
        `https://example.test/api/v1/me/passes/${pass.id}/lost-phone`,
        { method: 'POST', headers: mine.headers },
        kit.env,
      ),
    );
  return { kit, pass, lost };
}

describe('I lost my phone on a pass with a desk lookup', () => {
  it("is refused when the barcode is the lookup value (Henry's)", async () => {
    const { kit, pass, lost } = await lostPhone('{{memberNo}}');
    await expectProblem(await lost(), 409, 'PASS_CREDENTIAL_FIXED');
    expect((await getPass(kit.env.DB, pass.id))?.barcodeHash).toBe(pass.barcodeHash);
  });

  it('replaces the code twice and the old barcode stops admitting when it is not the lookup', async () => {
    const { kit, pass, lost } = await lostPhone();
    const scanner = await kit.scanner({ templateIds: [pass.templateId] });
    const scan = async (code: string) =>
      (
        await kit.post(scanner.headers, '/resolve', {
          idempotencyKey: key(),
          input: { code, method: 'camera' },
          clientTs: kit.clock.now(),
        })
      ).json();
    expect(await scan(codeOf(pass).code)).toMatchObject({ kind: 'ready' });
    const first = await lost();
    expect(first.status).toBe(202);
    expect(await scan(codeOf(pass).code)).not.toMatchObject({ kind: 'ready' });
    const afterFirst = await getPass(kit.env.DB, pass.id);
    expect(afterFirst?.scanCode).not.toBe(pass.scanCode);
    expect((await lost()).status).toBe(202);
    expect((await getPass(kit.env.DB, pass.id))?.scanCode).not.toBe(afterFirst?.scanCode);
  });
});
