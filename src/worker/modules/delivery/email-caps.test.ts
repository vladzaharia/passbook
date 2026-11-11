import { beforeAll, describe, expect, it } from 'vitest';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { EMAIL_RECIPIENT_HOURLY_CAP, enqueuePassEmail } from './issuance-intent.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const make = (mode: 'live' | 'test') =>
  createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: `Caps ${mode}` },
    source: 'manual',
    mode,
    actor: { type: 'system', id: null },
    execution: { kind: 'system' },
  });

describe('email caps are per mode', () => {
  it('captured test mail does not use up the live recipient cap', async () => {
    const test = await make('test');
    const live = await make('live');
    const to = 'shared@example.com';
    for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++)
      await enqueuePassEmail(job(), { passId: test.id, to, attach: false, expected: test });
    await expect(
      enqueuePassEmail(job(), { passId: test.id, to, attach: false, expected: test }),
    ).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
    await expect(
      enqueuePassEmail(job(), { passId: live.id, to, attach: false, expected: live }),
    ).resolves.toHaveProperty('outboxId');
  });

  it('live mail still counts against its own cap', async () => {
    const live = await make('live');
    const to = 'live-only@example.com';
    for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++)
      await enqueuePassEmail(job(), { passId: live.id, to, attach: false, expected: live });
    await expect(
      enqueuePassEmail(job(), { passId: live.id, to, attach: false, expected: live }),
    ).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
  });
});
