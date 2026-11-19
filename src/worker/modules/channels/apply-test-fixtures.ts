import { makeOrg } from '../../../../test/helpers/index.ts';
import type { Channel } from '../../../shared/contracts/channels.ts';
import { all, first, run } from '../../platform/db.ts';
import { runChannelApply } from '../../workflows/channel-apply.ts';
import { addBroadcastAdminMembership } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import type { Pass } from '../passes/repo.ts';
import { handleAppleBump } from './jobs.ts';

type Fn = () => Promise<unknown>;
const fnOf = (a: unknown, b: unknown) => (typeof a === 'function' ? a : b) as Fn;

export interface Stepper {
  names: string[];
  /** The step with this index runs twice: a retry after a crash that came after its commit. */
  retryAt?: number;
}

/** A workflow step that runs inline and moves the clock instead of sleeping. */
export function stepper(
  clock: { now(): number; set(ms: number): void },
  opts: { retryAt?: number; onSleep?: (name: string) => Promise<void> } = {},
) {
  const s: Stepper = { names: [], ...opts };
  const wake = (ms: number) => clock.set(Math.max(clock.now(), ms));
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      if (s.retryAt === s.names.length) await fnOf(a, b)();
      const result = await fnOf(a, b)();
      s.names.push(name);
      return result;
    },
    sleep: async (name: string, duration: string) => {
      s.names.push(name);
      const [n, unit] = duration.split(' ');
      wake(clock.now() + Number(n) * (unit?.startsWith('minute') ? 60_000 : 1000));
      await opts.onSleep?.(name);
    },
    sleepUntil: async (name: string, at: Date) => {
      s.names.push(name);
      wake(at.getTime());
    },
  } as unknown as Parameters<typeof runChannelApply>[3];
  return { step, s };
}

export async function applyKit(passCount = 3) {
  const kit = await ruleKit();
  const created: { id: string; params: unknown }[] = [];
  const instanceStatus = new Map<string, string>();
  Object.assign(kit.env, {
    CHANNEL_APPLY: {
      async create(o: { id: string; params: unknown }) {
        created.push(o);
        return { id: o.id };
      },
      async get(id: string) {
        if (!created.some((c) => c.id === id)) throw new Error('instance.not_found');
        return { status: async () => ({ status: instanceStatus.get(id) ?? 'running' }) };
      },
    },
  });
  const first_ = await kit.datedPass();
  const templateId = first_.templateId;
  const orgId = kit.org.id;
  const db = kit.env.DB;
  const passes: Pass[] = [first_];
  for (let i = 1; i < passCount; i++) passes.push(await kit.datedPass());
  // Pass rows are stamped with the clock: later channel rows must read as newer.
  kit.clock.advance(1000);

  const revision = async (mode = 'live') =>
    (
      await first<{ revision: number }>(
        db,
        'SELECT revision FROM template_channel_policies WHERE org_id = ? AND mode = ? AND template_id = ?',
        [orgId, mode, templateId],
      )
    )?.revision ?? 0;
  const save = async (channels: Partial<Record<Channel, string>>) =>
    kit.send('PUT', `/templates/${templateId}/channels`, {
      orgId,
      revision: await revision(),
      channels,
    });
  const saved = async (channels: Partial<Record<Channel, string>>) => {
    const res = await save(channels);
    if (res.status !== 200) throw new Error(`save ${res.status} ${await res.text()}`);
    return (await res.json()) as { workflowInstanceId: string | null };
  };
  const runOf = (id: string) =>
    first<Record<string, unknown>>(db, 'SELECT * FROM channel_apply_runs WHERE id = ?', [id]);
  const runs = () =>
    all<Record<string, unknown>>(
      db,
      'SELECT * FROM channel_apply_runs WHERE org_id = ? AND template_id = ? ORDER BY id',
      [orgId, templateId],
    );
  /** Runs the workflow for a run id inline. */
  const work = (
    runId: string,
    opts: { retryAt?: number; onSleep?: (name: string) => Promise<void> } = {},
  ) => {
    const { step, s } = stepper(kit.clock, opts);
    return {
      s,
      done: runChannelApply(kit.env, runId, { runId }, step, undefined, kit.clock),
    };
  };
  const count = async (sql: string, ...p: (string | number)[]) =>
    (await first<{ n: number }>(db, sql, p))?.n ?? 0;
  const ids = passes.map((p) => p.id);
  const feed = (passIds = ids) =>
    count(
      `SELECT COUNT(*) AS n FROM event_feed WHERE type = 'pass.channels_changed' AND pass_id IN (${passIds.map(() => '?').join(',')})`,
      ...passIds,
    );
  const audits = (action: string) =>
    count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND org_id = ?', action, orgId);
  const retired = async (channel: Channel) =>
    all<{ pass_id: string; revision: number; retired_at: number | null }>(
      db,
      `SELECT pass_id, revision, retired_at FROM pass_channels WHERE channel = ? AND pass_id IN (${ids.map(() => '?').join(',')}) AND retired_at IS NOT NULL`,
      [channel, ...ids],
    );
  /** Delivers the queued Apple republishes the way the queue would. */
  const drainBumps = async () => {
    const jobs = (kit.queue.sent as { kind: string }[]).filter(
      (m) => m.kind === 'channel.apple_bump',
    );
    for (const job of jobs)
      await handleAppleBump(job as Parameters<typeof handleAppleBump>[0], jobCtxOf(kit));
    return jobs.length;
  };
  const bumpsQueued = () =>
    (kit.queue.sent as { kind: string }[]).filter((m) => m.kind === 'channel.apple_bump').length;
  /** A pass of the same template in another mode, with its own release. */
  const passIn = async (mode: 'live' | 'test') => {
    const version = (await kit.registry.resolve(templateId)).version;
    const release = await approveAppleRelease(kit, { templateId, version, orgId, mode });
    return createPassRow(jobCtxOf(kit), {
      orgId,
      templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Other' },
      holderEmail: null,
      source: 'manual',
      mode,
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
  };
  /** A second org using the same (shared) template: its own pass and policy saves. */
  const otherOrg = async () => {
    const org = await makeOrg(kit.fx);
    await addBroadcastAdminMembership(kit, org.id);
    const version = (await kit.registry.resolve(templateId)).version;
    const release = await approveAppleRelease(kit, {
      templateId,
      version,
      orgId: org.id,
      mode: 'live',
    });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: org.id,
      templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Elsewhere' },
      holderEmail: null,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const save = async (channels: Partial<Record<Channel, string>>) => {
      const rev =
        (
          await first<{ revision: number }>(
            db,
            'SELECT revision FROM template_channel_policies WHERE org_id = ? AND template_id = ?',
            [org.id, templateId],
          )
        )?.revision ?? 0;
      const res = await kit.send('PUT', `/templates/${templateId}/channels`, {
        orgId: org.id,
        revision: rev,
        channels,
      });
      return (await res.json()) as { workflowInstanceId: string };
    };
    return { orgId: org.id, pass, save };
  };
  const exec = (sql: string, ...p: (string | number)[]) => run(db, sql, p);
  return {
    kit,
    created,
    instanceStatus,
    otherOrg,
    passes,
    ids,
    templateId,
    orgId,
    db,
    save,
    saved,
    runOf,
    runs,
    work,
    count,
    feed,
    audits,
    retired,
    drainBumps,
    bumpsQueued,
    passIn,
    exec,
    revision,
  };
}
