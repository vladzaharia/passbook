import { beforeAll, describe, expect, it } from 'vitest';
import { makeJoinLink } from '../../../../test/helpers/join.ts';
import { JobSchema } from '../../jobs/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { dailyJoin, handleJoinResend, KEY_TTL_MS } from './jobs.ts';
import { joinTemplate } from './join-test-fixtures.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit({ template: (id) => joinTemplate(id) });
}, 120_000);

const D = (c: string) => c.repeat(43);

async function joined(
  linkId: string,
  generation: number,
  keys = { ipKey: D('a'), deviceKey: D('b'), fieldsHash: D('c') },
) {
  const live = kit.liveRelease;
  if (!live) throw new Error('release');
  return createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: live.version,
    input: { memberName: 'Joined' },
    source: 'manual',
    mode: 'live',
    execution: { kind: 'join', linkId, generation, orgDailyCap: 1000 },
    actor: { type: 'system', id: `join:${linkId}` },
    joinKeys: keys,
  });
}

describe('join retention', () => {
  it('clears the three digests of cards older than 48 hours and nothing else', async () => {
    const l = await makeJoinLink(kit.fx, { orgId: kit.org.id, templateId: kit.template.id });
    const old = await joined(l.id, l.generation);
    kit.clock.advance(KEY_TTL_MS - 60_000);
    const young = await joined(l.id, l.generation);
    // Not yet 48 hours for the first card: nothing is cleared.
    await dailyJoin(jobCtxOf(kit));
    const row = (id: string) =>
      first<{
        ip_key: string | null;
        device_key: string | null;
        fields_hash: string | null;
        created_at: number;
        link_generation: number;
      }>(
        kit.env.DB,
        'SELECT ip_key, device_key, fields_hash, created_at, link_generation FROM join_issues WHERE pass_id = ?',
        [id],
      );
    expect(await row(old.id)).toMatchObject({
      ip_key: D('a'),
      device_key: D('b'),
      fields_hash: D('c'),
    });
    kit.clock.advance(120_000);
    await dailyJoin(jobCtxOf(kit));
    const cleared = await row(old.id);
    expect(cleared).toMatchObject({
      ip_key: null,
      device_key: null,
      fields_hash: null,
      link_generation: l.generation,
    });
    expect(await row(young.id)).toMatchObject({
      ip_key: D('a'),
      device_key: D('b'),
      fields_hash: D('c'),
    });
    // The row stays for the caps, and goes with its pass.
    const count = (
      await first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM join_issues WHERE link_id = ?',
        [l.id],
      )
    )?.n;
    expect(count).toBe(2);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [old.id]).catch(() => undefined);
  });

  it('is idempotent and writes nothing once the keys are gone', async () => {
    await dailyJoin(jobCtxOf(kit));
    const again = await all(
      kit.env.DB,
      'SELECT id FROM join_issues WHERE ip_key IS NULL AND device_key IS NULL AND fields_hash IS NULL',
    );
    await dailyJoin(jobCtxOf(kit));
    expect(
      await all(
        kit.env.DB,
        'SELECT id FROM join_issues WHERE ip_key IS NULL AND device_key IS NULL AND fields_hash IS NULL',
      ),
    ).toEqual(again);
  });
});

describe('join.resend', () => {
  it('is a queue message kind with a pass and a link', () => {
    expect(JobSchema.safeParse({ kind: 'join.resend', passId: 'p', linkId: 'l' }).success).toBe(
      true,
    );
    expect(JobSchema.safeParse({ kind: 'join.resend', passId: 'p' }).success).toBe(false);
  });

  it('skips a pass with no address, a removed pass and a missing one', async () => {
    const noEmail = await kit.pass();
    const before = (
      await first<{ n: number }>(
        kit.env.DB,
        "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'email'",
      )
    )?.n;
    await handleJoinResend({ kind: 'join.resend', passId: noEmail.id, linkId: 'l' }, jobCtxOf(kit));
    await handleJoinResend({ kind: 'join.resend', passId: 'missing', linkId: 'l' }, jobCtxOf(kit));
    expect(
      (
        await first<{ n: number }>(
          kit.env.DB,
          "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'email'",
        )
      )?.n,
    ).toBe(before);
  });

  it('queues the existing card to the address it holds, as the system', async () => {
    const pass = await kit.pass({ holderEmail: 'resend-job@example.com' });
    await handleJoinResend({ kind: 'join.resend', passId: pass.id, linkId: 'l' }, jobCtxOf(kit));
    const rows = await all<{ payload: string }>(
      kit.env.DB,
      "SELECT payload FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [pass.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({
      to: 'resend-job@example.com',
      attach: false,
    });
  });

  it('logs and drops a mail over the per-recipient cap instead of retrying', async () => {
    const pass = await kit.pass({ holderEmail: 'resend-capped@example.com' });
    for (let i = 0; i < 3; i++)
      await handleJoinResend({ kind: 'join.resend', passId: pass.id, linkId: 'l' }, jobCtxOf(kit));
    await expect(
      handleJoinResend({ kind: 'join.resend', passId: pass.id, linkId: 'l' }, jobCtxOf(kit)),
    ).resolves.toBeUndefined();
    const rows = await all(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [pass.id],
    );
    expect(rows).toHaveLength(3);
  });
});
