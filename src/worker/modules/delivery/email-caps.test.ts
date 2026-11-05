import { beforeAll, describe, expect, it } from 'vitest';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { EMAIL_RECIPIENT_HOURLY_CAP, enqueuePassEmail } from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const make = (mode: 'live' | 'test') =>
  createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    input: { memberName: `Caps ${mode}` },
    source: 'manual',
    mode,
    actor: { type: 'system', id: null },
  });

describe('email caps are per mode', () => {
  it('captured test mail does not use up the live recipient cap', async () => {
    const test = await make('test');
    const live = await make('live');
    const to = 'shared@example.com';
    for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++)
      await enqueuePassEmail(kit.ctx, { passId: test.id, to, attach: false });
    await expect(
      enqueuePassEmail(kit.ctx, { passId: test.id, to, attach: false }),
    ).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
    await expect(
      enqueuePassEmail(kit.ctx, { passId: live.id, to, attach: false }),
    ).resolves.toHaveProperty('outboxId');
  });

  it('live mail still counts against its own cap', async () => {
    const live = await make('live');
    const to = 'live-only@example.com';
    for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++)
      await enqueuePassEmail(kit.ctx, { passId: live.id, to, attach: false });
    await expect(
      enqueuePassEmail(kit.ctx, { passId: live.id, to, attach: false }),
    ).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
  });
});
