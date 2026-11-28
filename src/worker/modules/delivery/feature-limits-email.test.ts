import { beforeAll, describe, expect, it } from 'vitest';
import { setLimit } from '../../../../test/helpers/index.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { beforeBatch } from '../scan/batch-interceptor-test-support.ts';
import { RACE_GRANT_INSERT } from '../scan/race-tags.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { emailCaps } from './email-limits.ts';
import { enqueuePassEmail } from './issuance-intent.ts';

let kit: Kit;
let n = 0;
beforeAll(async () => {
  kit = await setupKit();
});

const pass = () =>
  createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: 'Mail limit' },
    source: 'manual',
    mode: 'live',
    actor: { type: 'system', id: null },
    execution: { kind: 'system' },
  });

/** One pass email to a new address, so only the org's daily cap can refuse it. */
const send = async (p: Awaited<ReturnType<typeof pass>>) =>
  enqueuePassEmail(jobCtxOf(kit), {
    passId: p.id,
    to: `guest-${++n}@example.com`,
    attach: false,
    expected: p,
  }).then(
    () => null,
    (e: { code?: string; status?: number }) => ({ code: e.code, status: e.status }),
  );

describe('emails per day', () => {
  it('a legacy org keeps the org setting as its only cap', async () => {
    const caps = await emailCaps(kit.ctx, kit.org.id);
    expect(caps.orgCap).toBe(500);
  });

  it('n-1 sends and n is refused with the rate-limit answer, and the cap is the plan value', async () => {
    const p = await pass();
    await setLimit(kit.env.DB, kit.org.id, 'email.perDay', 2);
    expect((await emailCaps(kit.ctx, kit.org.id)).orgCap).toBe(2);
    expect(await send(p)).toBeNull();
    expect(await send(p)).toBeNull();
    expect(await send(p)).toEqual({ code: 'EMAIL_RATE_LIMITED', status: 429 });
  });

  it('a plan value above the org setting does not raise it, and a downgrade keeps queued mail', async () => {
    await setLimit(kit.env.DB, kit.org.id, 'email.perDay', 100_000);
    expect((await emailCaps(kit.ctx, kit.org.id)).orgCap).toBe(500);
    await setLimit(kit.env.DB, kit.org.id, 'email.perDay', 0);
    expect((await emailCaps(kit.ctx, kit.org.id)).orgCap).toBe(0);
  });

  it('the queue grant re-reads the plan at commit: a downgrade after the check refuses the mail', async () => {
    const p = await pass();
    await setLimit(kit.env.DB, kit.org.id, 'email.perDay', null);
    const { result: raced, fired } = await beforeBatch(
      kit.env,
      RACE_GRANT_INSERT,
      () => setLimit(kit.env.DB, kit.org.id, 'email.perDay', 0),
      () => send(p),
    );
    expect(fired).toBe(true);
    expect(raced).toEqual({ code: 'EMAIL_RATE_LIMITED', status: 429 });
    await setLimit(kit.env.DB, kit.org.id, 'email.perDay', null);
    expect(await send(p)).toBeNull();
  });
});
