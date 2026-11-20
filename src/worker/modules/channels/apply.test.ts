import { describe, expect, it } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { applyChannelPage } from './apply-page.ts';
import { failRun, finishRun, startOne } from './apply-run.ts';
import { applyKit } from './apply-test-fixtures.ts';

describe('channel apply: save', () => {
  it('opens one pending run, starts one instance, and later saves join and push it back', async () => {
    const t = await applyKit();
    const first = await t.saved({ apple: 'off' });
    expect(first.workflowInstanceId).toBeTruthy();
    expect(t.created).toHaveLength(1);
    expect(t.created[0]).toEqual({
      id: first.workflowInstanceId,
      params: { runId: first.workflowInstanceId },
    });
    const run1 = await t.runOf(first.workflowInstanceId as string);
    expect(run1).toMatchObject({
      state: 'pending',
      from_channels: '{}',
      from_revision: 0,
      replace_channels: '[]',
    });

    t.kit.clock.advance(5 * 60_000);
    const second = await t.saved({ apple: 'on', mobile: 'off' });
    expect(second.workflowInstanceId).toBe(first.workflowInstanceId);
    expect(t.created).toHaveLength(1);
    const rows = await t.runs();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.due_at)).toBe(t.kit.clock.now() + 10 * 60_000);
    expect(rows[0]?.from_channels).toBe('{}');
  });

  it('refuses the seventh save of a day, and a dry run never counts', async () => {
    const t = await applyKit(1);
    for (let i = 0; i < 6; i++) await t.saved({ apple: i % 2 === 0 ? 'off' : 'on' });
    await t.save({ apple: 'on', mobile: 'off' }).then((r) => expect(r.status).toBe(429));
    const dry = await t.kit.send('PUT', `/templates/${t.templateId}/channels`, {
      orgId: t.orgId,
      revision: await t.revision(),
      channels: { apple: 'on' },
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    t.kit.clock.advance(24 * 3_600_000);
    expect((await t.save({ apple: 'on', mobile: 'off' })).status).toBe(200);
  });

  it('lists the latest runs of the template in the caller mode', async () => {
    const t = await applyKit(1);
    const { workflowInstanceId } = await t.saved({ apple: 'off' });
    const res = await t.kit.api(`/templates/${t.templateId}/channels/runs?orgId=${t.orgId}`, {
      headers: t.kit.auth.admin(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: workflowInstanceId,
        state: 'pending',
        dueAt: expect.any(Number),
        startedAt: null,
        finishedAt: null,
        counts: { changed: 0, flips: 0, stale: 0, rotated: 0, unsupported: 0 },
        errorCode: null,
        waiting: null,
      },
    ]);
    const test = await t.kit.api(`/templates/${t.templateId}/channels/runs?orgId=${t.orgId}`, {
      headers: t.kit.auth.admin({ mode: 'test' }),
    });
    expect(await test.json()).toEqual([]);
  });
});

describe('channel apply: workflow', () => {
  it('retires Apple on every pass once, with audits, events, queued republishes and a finished run', async () => {
    const t = await applyKit();
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    const before = await t.feed();
    const w = t.work(id);
    expect(await w.done).toEqual({ state: 'done' });
    expect(w.s.names.slice(0, 3)).toEqual(['due-0', 'wait-0', 'due-1']);
    expect(await t.runOf(id)).toMatchObject({
      state: 'done',
      to_channels: '{"apple":"off"}',
      counts: '{"changed":3,"flips":3,"stale":0,"rotated":0,"unsupported":0}',
      cursor: t.ids.toSorted().at(-1),
    });
    expect(await t.retired('apple')).toHaveLength(3);
    expect(await t.feed()).toBe(before + 3);
    expect(await t.audits('pass.channels_change')).toBe(3);
    expect(await t.audits('template.channels_apply')).toBe(1);
    expect(await t.bumpsQueued()).toBe(3);
    expect(
      await t.count(
        'SELECT COUNT(*) AS n FROM channel_apply_marks WHERE run_id = ? AND journaled_at IS NOT NULL',
        id,
      ),
    ).toBe(3);
  });

  it('records an event only for an effective flip', async () => {
    const t = await applyKit();
    await t.kit.send('PUT', `/passes/${t.ids[0]}/channels`, { channels: { apple: 'off' } });
    const before = await t.feed();
    const bumps = t.bumpsQueued();
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    await t.work(id).done;
    expect(await t.feed()).toBe(before + 2);
    expect(await t.runOf(id)).toMatchObject({
      counts: '{"changed":2,"flips":2,"stale":0,"rotated":0,"unsupported":0}',
    });
    expect(t.bumpsQueued()).toBe(bumps + 2);
  });

  it('drops a run whose policy is back where it began', async () => {
    const t = await applyKit();
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    await t.saved({ apple: 'on' });
    const before = await t.feed();
    expect(await t.work(id).done).toEqual({ state: 'dropped' });
    expect(await t.runOf(id)).toMatchObject({ state: 'dropped', to_channels: null });
    expect(await t.retired('apple')).toHaveLength(0);
    expect(await t.feed()).toBe(before);
    expect(t.bumpsQueued()).toBe(0);
  });

  it('queues a successor for a save during a run, and its from is the earlier to', async () => {
    const t = await applyKit();
    const { workflowInstanceId: a } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    t.kit.clock.advance(10 * 60_000);
    expect(await startOne(jobCtxOf(t.kit), a)).toBe('started');

    const { workflowInstanceId: b } = (await t.saved({ apple: 'on' })) as {
      workflowInstanceId: string;
    };
    expect(b).not.toBe(a);
    expect(t.created.map((c) => c.id)).toEqual([a, b]);
    expect(await t.runOf(b)).toMatchObject({ state: 'pending', from_channels: '{"apple":"off"}' });

    // The second run cannot start while the first runs: it waits, then is dropped or runs after.
    const second = t.work(b);
    const first = t.work(a);
    // `a` is already running; the workflow instance for it would find it running and stop.
    expect(await first.done).toEqual({ state: 'running' });
    await applyChannelPage(jobCtxOf(t.kit), a);
    await finishRun(jobCtxOf(t.kit), a);
    expect(await t.retired('apple')).toHaveLength(3);
    expect(await second.done).toEqual({ state: 'done' });
    expect(await t.retired('apple')).toHaveLength(0);
    expect(await t.runOf(b)).toMatchObject({
      to_channels: '{"apple":"on"}',
      counts: '{"changed":3,"flips":3,"stale":0,"rotated":0,"unsupported":0}',
    });
  });

  it('keeps other modes and the template of other runs untouched', async () => {
    const t = await applyKit(2);
    const testPass = await t.passIn('test');
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    await t.work(id).done;
    expect(await t.retired('apple')).toHaveLength(2);
    expect(
      await t.count('SELECT COUNT(*) AS n FROM pass_channels WHERE pass_id = ?', testPass.id),
    ).toBe(0);
  });

  it('ends a run as failed when the org is suspended', async () => {
    const t = await applyKit();
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    const w = t.work(id);
    // Past the debounce the org is suspended: the first page refuses.
    await t.exec("UPDATE orgs SET status = 'suspended' WHERE id = ?", t.orgId);
    await expect(w.done).resolves.toEqual({ state: 'failed' });
    expect(await t.runOf(id)).toMatchObject({
      state: 'failed',
      error_code: 'CHANNEL_APPLY_ORG_INACTIVE',
    });
  });

  it('fails a running run at the page when the org is suspended meanwhile', async () => {
    const t = await applyKit();
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    const ctx = jobCtxOf(t.kit);
    expect(await startOne(ctx, id)).toBe('started');
    await t.exec("UPDATE orgs SET status = 'suspended' WHERE id = ?", t.orgId);
    expect(await applyChannelPage(ctx, id)).toEqual({
      done: true,
      failed: 'CHANNEL_APPLY_ORG_INACTIVE',
    });
    await failRun(ctx, id, 'CHANNEL_APPLY_ORG_INACTIVE');
    expect(await t.runOf(id)).toMatchObject({
      state: 'failed',
      error_code: 'CHANNEL_APPLY_ORG_INACTIVE',
    });
    expect(await t.retired('apple')).toHaveLength(0);
  });
});

describe('channel apply: paper', () => {
  it('turns paper off for a pass in the same commit as its marker and mark', async () => {
    const t = await applyKit(1);
    await t.exec(
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
    );
    const { clearSettingsCache } = await import('../settings/service.ts');
    clearSettingsCache(t.db);
    const { workflowInstanceId: on } = (await t.saved({ paper: 'on' })) as {
      workflowInstanceId: string;
    };
    await t.work(on).done;
    const { workflowInstanceId: off } = (await t.saved({ paper: 'off' })) as {
      workflowInstanceId: string;
    };
    await t.exec(
      "INSERT INTO pass_prints (id, pass_id, org_id, mode, print_code_hash, roster_hash, generation, status, created_by, created_at) VALUES ('pr1', ?, ?, 'live', ?, ?, 1, 'active', 'test', 1)",
      t.ids[0] ?? '',
      t.orgId,
      'a'.repeat(64),
      'b'.repeat(32),
    );
    const before = await t.feed();
    expect(await t.work(off).done).toEqual({ state: 'done' });
    expect(await t.runOf(off)).toMatchObject({
      counts: '{"changed":1,"flips":1,"stale":0,"rotated":0,"unsupported":0}',
    });
    expect(
      await t.count(
        "SELECT COUNT(*) AS n FROM pass_prints WHERE id = 'pr1' AND status = 'voided' AND void_cause = 'channel_off'",
      ),
    ).toBe(1);
    expect(await t.audits('pass.print_void')).toBe(1);
    expect(await t.feed()).toBe(before + 1);
  });
});
