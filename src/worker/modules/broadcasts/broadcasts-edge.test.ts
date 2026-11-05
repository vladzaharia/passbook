import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { BroadcastSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { runBroadcast } from '../../workflows/broadcast.ts';
import { getPass } from '../passes/repo.ts';
import { applyChunk } from './apply.ts';
import { insertItems } from './repo.ts';
import { failStuckBroadcasts, launchBroadcast } from './start.ts';
import { type BroadcastKit, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: BroadcastKit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await broadcastKit();
  app = createApp({ stores: fake.stores });
});

const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const post = (path: string, body: unknown = {}) =>
  api(path, {
    method: 'POST',
    headers: { ...fake.admin(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const dto = async (res: Response) => BroadcastSchema.parse(await res.json());
const stepRun = {
  do: async (_n: string, a: unknown, b?: unknown) =>
    await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Parameters<typeof runBroadcast>[3];

/** Only the given passes stay targetable. */
async function isolate(keep: string[]) {
  await run(
    kit.env.DB,
    `UPDATE passes SET status = 'voided' WHERE template_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`,
    [kit.messaging.id, ...keep],
  );
}
const messageBody = (text: string, extra: Record<string, unknown> = {}) => ({
  orgId: kit.org.id,
  kind: 'message',
  target: { templateIds: [kit.messaging.id] },
  patch: { message: text },
  ...extra,
});
async function sendNow(body: Record<string, unknown>) {
  const before = kit.broadcast.created.length;
  const made = await dto(await post('/broadcasts', body));
  const instance = kit.broadcast.created.at(before);
  await runBroadcast(kit.env, instance?.id ?? '', { broadcastId: made.id }, stepRun);
  await kit.settle();
  return dto(await api(`/broadcasts/${made.id}`, { headers: fake.admin() }));
}
const versionsOf = async (passId: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?',
      [passId],
    )
  )?.n;
const pushEvents = (passId: string) =>
  all<{ kind: string }>(
    kit.env.DB,
    `SELECT kind FROM pass_events WHERE pass_id = ? AND kind IN ('push.queued', 'pass.updated')`,
    [passId],
  );

describe('no-op broadcasts', () => {
  it('clearing a pass that never had a message does not push it', async () => {
    const pass = await kit.makePass();
    await isolate([pass.id]);
    const before = await pushEvents(pass.id);
    const done = await sendNow(messageBody(''));
    expect(done.counts).toMatchObject({ updated: 0, unchanged: 1 });
    expect(await pushEvents(pass.id)).toHaveLength(before.length);
    expect(await versionsOf(pass.id)).toBe(1);
  });

  it('a change to an input the template does not render does not push', async () => {
    const pass = await kit.makePass();
    await isolate([pass.id]);
    const before = await pushEvents(pass.id);
    const done = await sendNow({
      orgId: kit.org.id,
      kind: 'change',
      target: { templateIds: [kit.messaging.id] },
      patch: { note: 'unseen' },
    });
    expect(done.counts).toMatchObject({ updated: 0, unchanged: 1 });
    expect(await pushEvents(pass.id)).toHaveLength(before.length);
    expect((await getPass(kit.env.DB, pass.id, null))?.personalization.note).toBe('unseen');
  });
});

describe('target', () => {
  it('skips expired passes in the count and the run', async () => {
    const live = await kit.makePass();
    const old = await kit.makePass();
    await isolate([live.id, old.id]);
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', '2020-01-01T00:00:00Z')
       WHERE pass_id = ?`,
      [old.id],
    );
    const count = (await (
      await post('/broadcasts/preview', {
        orgId: kit.org.id,
        target: { templateIds: [kit.messaging.id] },
      })
    ).json()) as { targeted: number };
    expect(count.targeted).toBe(1);
    const done = await sendNow(messageBody('Hello'));
    expect(done.counts).toMatchObject({ targeted: 1, updated: 1, unchanged: 0 });
    expect(await versionsOf(old.id)).toBe(1);
  });

  it('walks more than one chunk and a retried chunk skips what it handled', async () => {
    const passes = [];
    for (let i = 0; i < 5; i++) passes.push(await kit.makePass());
    await isolate(passes.map((p) => p.id));
    const made = await dto(await post('/broadcasts', messageBody('Chunked', { send: 'draft' })));
    await post(`/broadcasts/${made.id}/send`);
    await run(kit.env.DB, 'UPDATE broadcasts SET state = ? WHERE id = ?', ['sending', made.id]);
    let cursor: string | null = null;
    let chunks = 0;
    do {
      ({ nextCursor: cursor } = await applyChunk(kit.ctx, made.id, cursor, 2));
      chunks++;
    } while (cursor);
    expect(chunks).toBe(3);
    const items = await all<{ outcome: string }>(
      kit.env.DB,
      'SELECT outcome FROM broadcast_items WHERE broadcast_id = ?',
      [made.id],
    );
    expect(items.filter((i) => i.outcome === 'updated')).toHaveLength(5);

    // A chunk retried after the publish but before its item row: the pass counts as unchanged.
    await run(kit.env.DB, 'DELETE FROM broadcast_items WHERE broadcast_id = ? AND pass_id = ?', [
      made.id,
      passes[0]?.id,
    ]);
    await applyChunk(kit.ctx, made.id, null, 100);
    const again = await first<{ outcome: string }>(
      kit.env.DB,
      'SELECT outcome FROM broadcast_items WHERE broadcast_id = ? AND pass_id = ?',
      [made.id, passes[0]?.id],
    );
    expect(again?.outcome).toBe('unchanged');
    expect(await versionsOf(passes[0]?.id ?? '')).toBe(2);
    void insertItems;
  });
});

describe('stuck broadcasts', () => {
  const instanceStatus = (status: string | Error) => {
    (kit.env as unknown as { BROADCAST: Record<string, unknown> }).BROADCAST.get = async () => {
      if (status instanceof Error) throw status;
      return { status: async () => ({ status }) };
    };
  };

  it('fails a send whose workflow ended, and leaves a running one alone', async () => {
    const made = await dto(await post('/broadcasts', messageBody('Stuck', { send: 'now' })));
    expect(made.state).toBe('sending');
    kit.clock.advance(10 * 60_000);
    instanceStatus('running');
    await failStuckBroadcasts(kit.ctx);
    expect((await dto(await api(`/broadcasts/${made.id}`, { headers: fake.admin() }))).state).toBe(
      'sending',
    );
    kit.clock.advance(6 * 60_000);
    instanceStatus('complete');
    await failStuckBroadcasts(kit.ctx);
    const failed = await dto(await api(`/broadcasts/${made.id}`, { headers: fake.admin() }));
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'BROADCAST_FAILED' });
  });

  it('a start that finds an ended instance fails the send instead of hanging', async () => {
    const draft = await dto(await post('/broadcasts', messageBody('Dup', { send: 'draft' })));
    await post(`/broadcasts/${draft.id}/send`, { at: kit.clock.now() + 60_000 });
    kit.clock.advance(120_000);
    const original = kit.broadcast.create;
    kit.broadcast.create = async () => {
      throw new Error('Instance already exists');
    };
    instanceStatus('errored');
    const started = await launchBroadcast(kit.ctx, { id: draft.id, org_id: kit.org.id });
    kit.broadcast.create = original;
    expect(started).toBe(false);
    expect((await dto(await api(`/broadcasts/${draft.id}`, { headers: fake.admin() }))).state).toBe(
      'failed',
    );
  });

  it('the workflow fails the send when its first step throws', async () => {
    const made = await dto(await post('/broadcasts', messageBody('Boom', { send: 'now' })));
    let calls = 0;
    const flaky = {
      do: async (name: string, a: unknown, b?: unknown) => {
        calls++;
        if (name === 'start') throw new Error('d1 down');
        return await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)();
      },
    } as unknown as Parameters<typeof runBroadcast>[3];
    await expect(
      runBroadcast(kit.env, `broadcast-${made.id}`, { broadcastId: made.id }, flaky),
    ).rejects.toThrow('d1 down');
    expect(calls).toBe(2);
    expect((await dto(await api(`/broadcasts/${made.id}`, { headers: fake.admin() }))).state).toBe(
      'failed',
    );
  });
});

describe('follow-up link', () => {
  it('the parent names its follow-up', async () => {
    const pass = await kit.makePass();
    await isolate([pass.id]);
    const sent = await sendNow(messageBody('Back soon', { clearAfter: 3_600_000 }));
    expect(sent.followUp?.at).toBeGreaterThan(kit.clock.now());
    const child = await dto(
      await api(`/broadcasts/${sent.followUp?.id}`, { headers: fake.admin() }),
    );
    expect(child.parentId).toBe(sent.id);
    expect(child.followUp).toBeNull();
  });
});
