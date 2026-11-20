import { describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyChannelPage } from './apply-page.ts';
import { startOne } from './apply-run.ts';
import { applyKit } from './apply-test-fixtures.ts';
import * as repoApply from './repo-apply.ts';

vi.mock('./repo-apply.ts', async (original) => {
  const real = await original<typeof import('./repo-apply.ts')>();
  return { ...real, channelRevisions: vi.fn(real.channelRevisions) };
});

type T = Awaited<ReturnType<typeof applyKit>>;

/** What a finished apply leaves, whatever went wrong on the way: once each. */
async function expectOnce(t: T, versions: Map<string, number>) {
  expect(await t.retired('apple')).toEqual(
    expect.arrayContaining(
      t.ids.map((id) => expect.objectContaining({ pass_id: id, revision: 1 })),
    ),
  );
  expect(await t.retired('apple')).toHaveLength(3);
  expect(await t.feed()).toBe(3);
  expect(await t.audits('pass.channels_change')).toBe(3);
  expect(await t.audits('template.channels_apply')).toBe(1);
  await t.drainBumps();
  for (const id of t.ids)
    expect((await getPass(t.db, id))?.version).toBe((versions.get(id) ?? 0) + 1);
}

const versionsOf = async (t: T) =>
  new Map(
    await Promise.all(
      t.ids.map(async (id) => [id, (await getPass(t.db, id))?.version ?? 0] as const),
    ),
  );

describe('channel apply: crash safety', () => {
  const STEPS = 6;
  it.each(Array.from({ length: STEPS }, (_, i) => i))(
    'a retry of step %i changes nothing twice',
    async (retryAt) => {
      const t = await applyKit();
      const versions = await versionsOf(t);
      const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
        workflowInstanceId: string;
      };
      const w = t.work(id, { retryAt });
      expect(await w.done).toEqual({ state: 'done' });
      await expectOnce(t, versions);
    },
  );

  it('resumes a page that died after its first pass, with no lost or double republish', async () => {
    const t = await applyKit();
    const versions = await versionsOf(t);
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    const ctx = jobCtxOf(t.kit);
    await startOne(ctx, id);
    t.kit.queue.fail = true;
    await expect(applyChannelPage(ctx, id)).rejects.toThrow('queue down');
    expect(await t.retired('apple')).toHaveLength(1);
    t.kit.queue.fail = false;
    expect(await applyChannelPage(ctx, id)).toEqual({ done: true });
    const { finishRun } = await import('./apply-run.ts');
    await finishRun(ctx, id);
    await expectOnce(t, versions);
  });

  it('re-reads a stale pass once, then skips it and counts it', async () => {
    const t = await applyKit(2);
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    const ctx = jobCtxOf(t.kit);
    await startOne(ctx, id);
    const stale = vi.mocked(repoApply.channelRevisions);
    const real = stale.getMockImplementation();
    stale.mockImplementation(async (db, passIds) => {
      const out = await (real as typeof repoApply.channelRevisions)(db, passIds);
      return new Map([...out].map(([k, v]) => [k, { ...v, apple: 99 }]));
    });
    // A row that exists at a revision other than the one read: every pass looks stale.
    for (const pid of t.ids)
      await t.exec(
        "INSERT INTO pass_channels (org_id, mode, pass_id, template_id, channel, set_by, set_at) VALUES (?, 'live', ?, ?, 'apple', 'test', 1)",
        t.orgId,
        pid,
        t.templateId,
      );
    expect(await applyChannelPage(ctx, id)).toEqual({ done: true });
    stale.mockImplementation(real as typeof repoApply.channelRevisions);
    expect((await t.runOf(id))?.counts).toBe(
      '{"changed":0,"flips":0,"stale":2,"rotated":0,"unsupported":0}',
    );
    expect(await t.retired('apple')).toHaveLength(0);
    expect(await t.audits('pass.channels_change')).toBe(0);
  });
});
