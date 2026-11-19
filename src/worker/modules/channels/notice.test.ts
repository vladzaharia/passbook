import { describe, expect, it } from 'vitest';
import { CHANNEL_COPY } from '../../../shared/copy/channels.ts';
import { runJob } from '../../jobs/registry.ts';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';

describe('holder notice mail', () => {
  const send = async (
    reason: 'codes_replaced' | 'channel_off',
    holderEmail: string | undefined,
  ) => {
    const kit = await setupKit();
    const pass = await kit.pass(holderEmail ? { holderEmail } : {});
    await runJob(
      {
        kind: 'pass.holder_mail',
        passId: pass.id,
        userId: null,
        reason,
        ...(reason === 'channel_off'
          ? { channels: ['apple', 'google'] as ('apple' | 'google')[] }
          : {}),
      },
      jobCtxOf(kit),
    );
    const outbox = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [pass.id],
    );
    for (const row of outbox)
      await handleEmailSend({ kind: 'email.send', outboxId: row.id }, jobCtxOf(kit));
    return { kit, pass, outbox, sent: kit.mailer.sent.at(-1) };
  };

  it('says the code changed, in the subject, the heading and the line', async () => {
    const { outbox, sent } = await send('codes_replaced', 'holder@example.com');
    expect(outbox).toHaveLength(1);
    expect(sent?.subject).toBe(CHANNEL_COPY.codesReplacedTitle);
    expect(sent?.text).toContain(CHANNEL_COPY.codesReplaced);
    expect(sent?.html).toContain(CHANNEL_COPY.codesReplacedTitle);
    expect(sent?.html).toContain(CHANNEL_COPY.codesReplaced);
    expect(sent?.text).not.toContain('Your pass is ready');
  });

  it('names the channels whose copies stopped working', async () => {
    const { sent } = await send('channel_off', 'holder@example.com');
    expect(sent?.subject).toBe('A copy of your pass stopped working');
    expect(sent?.text).toContain('Your Apple Wallet, Google Wallet copy no longer works.');
  });

  it('sends nothing to a pass with no holder email', async () => {
    const { outbox } = await send('codes_replaced', undefined);
    expect(outbox).toHaveLength(0);
  });

  it('audits the mail under its own action', async () => {
    const { kit, pass } = await send('codes_replaced', 'audit@example.com');
    const rows = await all<{ action: string }>(
      kit.env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action LIKE 'holder.%'",
      [pass.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['holder.codes_replaced_mail']);
  });
});
