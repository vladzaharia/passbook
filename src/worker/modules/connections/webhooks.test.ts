import { beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import type { Job } from '../../jobs/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { setDeps } from './deps.ts';
import * as service from './service.ts';
import { createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';
import { processWebhook, receiveWebhook } from './webhooks.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

async function pushConn(over: Record<string, unknown> = {}) {
  const dto = await createDemo(kit, {
    connectorType: 'webhook-push',
    config: {},
    mode: 'webhook',
    ...over,
  } as never);
  return { dto, secret: dto.webhookSecret as string };
}

async function signedRequest(
  secret: string,
  body: unknown,
  over: { ts?: number; raw?: string } = {},
) {
  const text = over.raw ?? JSON.stringify(body);
  const ts = over.ts ?? Math.floor(kit.clock.now() / 1000);
  return new Request('https://wallet.test/hooks/connections/x', {
    method: 'POST',
    body: text,
    headers: {
      'x-wallet-timestamp': String(ts),
      'x-wallet-signature': await signWebhook(secret, ts, text),
    },
  });
}

const event = (id: string, extra: object = {}) => ({
  id,
  records: [
    { ref: 'm-001', record: { memberName: 'Pushed A' } },
    { ref: 'm-002', deleted: true },
  ],
  ...extra,
});

const events = (connectionId: string) =>
  all<{ event_id: string }>(
    kit.env.DB,
    'SELECT event_id FROM webhook_events WHERE connection_id = ?',
    [connectionId],
  );

describe('receiveWebhook', () => {
  it('verifies, stores the event and records, and queues a job', async () => {
    const { dto, secret } = await pushConn();
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-1')));
    expect(kit.seams.jobs).toEqual([
      {
        kind: 'connection.webhook',
        connectionId: dto.id,
        orgId: kit.org.id,
        generation: 1,
        eventId: 'evt-1',
        refs: ['m-001', 'm-002'],
      },
    ]);
    expect((await events(dto.id)).map((e) => e.event_id)).toEqual(['evt-1']);
    const inbox = await all<{ ref: string; deleted: number }>(
      kit.env.DB,
      'SELECT ref, deleted FROM connection_inbox WHERE connection_id = ? ORDER BY ref',
      [dto.id],
    );
    expect(inbox).toEqual([
      { ref: 'm-001', deleted: 0 },
      { ref: 'm-002', deleted: 1 },
    ]);
  });

  it('acknowledges a duplicate delivery without queueing it again', async () => {
    const { dto, secret } = await pushConn();
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-d')));
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-d')));
    expect(kit.seams.jobs).toHaveLength(1);
    expect(await events(dto.id)).toHaveLength(1);
  });

  it('rejects a bad signature and records nothing', async () => {
    const { dto } = await pushConn();
    await expect(
      receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest('whsec_wrongwrongwrong1', event('evt-x')),
      ),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE', status: 401 });
    expect(kit.seams.jobs).toEqual([]);
    expect(await events(dto.id)).toEqual([]);
  });

  it('rejects a tampered body', async () => {
    const { dto, secret } = await pushConn();
    const req = await signedRequest(secret, event('evt-t'));
    const body = (await req.clone().text()).replace('Pushed A', 'Pushed B');
    const tampered = new Request(req.url, { method: 'POST', body, headers: req.headers });
    await expect(receiveWebhook(kit.sctx, dto.id, tampered)).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE',
    });
  });

  it('rejects replays outside the window, even with a valid signature', async () => {
    const { dto, secret } = await pushConn();
    const old = Math.floor(kit.clock.now() / 1000) - 600;
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-old'), { ts: old })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE' });
    expect(kit.seams.jobs).toEqual([]);
  });

  it('rejects a signature made with another connection secret', async () => {
    const a = await pushConn();
    const b = await pushConn();
    await expect(
      receiveWebhook(kit.sctx, a.dto.id, await signedRequest(b.secret, event('evt-cross'))),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE' });
  });

  it('rejects malformed payloads with 400', async () => {
    const { dto, secret } = await pushConn();
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, null, { raw: 'not json' })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_PAYLOAD', status: 400 });
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, { records: 'x' })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_PAYLOAD' });
  });

  it('looks identical to a missing connection when disabled, polling-only or unknown', async () => {
    const { dto, secret } = await pushConn();
    const poll = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    for (const id of [dto.id, poll.id, 'no-such-id']) {
      await expect(
        receiveWebhook(kit.sctx, id, await signedRequest(secret, event('evt-n'))),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
  });

  it('removes the event when queueing fails so the sender can retry', async () => {
    const { dto, secret } = await pushConn();
    kit.seams.failEnqueue = true;
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-q'))),
    ).rejects.toMatchObject({ code: 'WEBHOOK_UNAVAILABLE', status: 503 });
    expect(await events(dto.id)).toEqual([]);
    kit.seams.failEnqueue = false;
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-q')));
    expect(kit.seams.jobs).toHaveLength(1);
  });

  it('uses the rotated secret and drops the old one', async () => {
    const { dto, secret } = await pushConn();
    const { rotateWebhookSecret } = await import('./actions.ts');
    const rotated = await rotateWebhookSecret(kit.sctx, kit.actor, dto.id);
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-r1'))),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE' });
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(rotated.webhookSecret, event('evt-r2')),
    );
    expect(kit.seams.jobs).toHaveLength(1);
  });
});

describe('processWebhook', () => {
  const job = (
    connectionId: string,
    eventId: string,
    refs: string[],
  ): Job & { kind: 'connection.webhook' } => ({
    kind: 'connection.webhook',
    connectionId,
    orgId: kit.org.id,
    generation: 1,
    eventId,
    refs,
  });

  it('applies pushed records, deletions and auto-created passes, and records a webhook run', async () => {
    const { dto, secret } = await pushConn({
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      onMissing: 'void',
    });
    const p1 = await linkedPass(kit, dto.id, 'm-001');
    const p2 = await linkedPass(kit, dto.id, 'm-002');
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(secret, {
        id: 'evt-p',
        records: [
          { ref: 'm-001', record: { memberName: 'Pushed A' } },
          { ref: 'm-002', deleted: true },
          { ref: 'm-003', record: { memberName: 'Brand new' } },
        ],
      }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.applied[0]).toMatchObject({
      passId: p1.id,
      fields: { memberName: 'Pushed A' },
    });
    expect(kit.seams.missing).toEqual([{ passId: p2.id, mode: 'void' }]);
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['m-003']);
    expect(kit.seams.created[0]).toMatchObject({
      orgId: kit.org.id,
      mode: 'live',
      generation: 1,
      templateVersion: expect.any(String),
    });
    const run = await first<{ trigger: string; outcome: string; records_seen: number }>(
      kit.env.DB,
      "SELECT trigger, outcome, records_seen FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
      [dto.id],
    );
    expect(run).toEqual({ trigger: 'webhook', outcome: 'changed', records_seen: 3 });
  });

  it('ignores events for deleted or disabled connections', async () => {
    const { dto } = await pushConn();
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    await processWebhook(kit.sctx, job(dto.id, 'e', ['a']));
    await processWebhook(kit.sctx, job('gone', 'e', ['a']));
    expect(kit.seams.applied).toEqual([]);
  });

  it('hybrid: fetches the refs named by the webhook through the connector', async () => {
    const fetched: string[] = [];
    setDeps({
      fetchImpl: (async (url: string) => {
        fetched.push(String(url));
        return new Response(JSON.stringify({ memberName: 'Fetched' }), { status: 200 });
      }) as typeof fetch,
    });
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
      mode: 'hybrid',
    } as never);
    const pass = await linkedPass(kit, dto.id, 'r9');
    const req = await signedRequest(dto.webhookSecret as string, { id: 'evt-h', refs: ['r9'] });
    await receiveWebhook(kit.sctx, dto.id, req);
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(fetched).toEqual(['https://api.example.com/m/r9']);
    expect(kit.seams.applied[0]).toMatchObject({
      passId: pass.id,
      fields: { memberName: 'Fetched' },
    });
  });

  it('records connector failures without touching passes', async () => {
    setDeps({ fetchImpl: (async () => new Response('x', { status: 401 })) as typeof fetch });
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'hybrid',
    } as never);
    await linkedPass(kit, dto.id, 'r9');
    await processWebhook(kit.sctx, job(dto.id, 'e', ['r9']));
    expect(kit.seams.applied).toEqual([]);
    const run = await first<{ outcome: string; error_code: string }>(
      kit.env.DB,
      "SELECT outcome, error_code FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
      [dto.id],
    );
    expect(run).toEqual({ outcome: 'error', error_code: 'AUTH' });
  });

  it('does not apply records to passes of another org', async () => {
    const { dto, secret } = await pushConn();
    const other = await makeOrg(kit);
    const theirs = await linkedPass(kit, dto.id, 'm-001', other.id);
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-iso')));
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(kit.seams.applied.map((a) => a.passId)).not.toContain(theirs.id);
  });

  it('ignores legacy Test, voided, deleted and removed bindings while syncing Live passes', async () => {
    const { dto, secret } = await pushConn({
      autoCreate: true, defaultTemplateId: kit.templateId, onMissing: 'void',
    });
    const test = await linkedPass(kit, dto.id, 'test-ref');
    const voided = await linkedPass(kit, dto.id, 'voided-ref');
    const deleted = await linkedPass(kit, dto.id, 'deleted-ref');
    const removed = await linkedPass(kit, dto.id, 'removed-ref');
    const live = await linkedPass(kit, dto.id, 'live-ref');
    const quarantined = await linkedPass(kit, dto.id, 'quarantined-ref');
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [test.id]);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [deleted.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [removed.id]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [quarantined.id]);
    const before = await all(
      kit.env.DB, 'SELECT * FROM passes WHERE id IN (?, ?, ?, ?, ?) ORDER BY id',
      [test.id, voided.id, deleted.id, removed.id, quarantined.id],
    );
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, {
      id: 'legacy-bindings',
      records: [
        { ref: 'test-ref', record: { memberName: 'Test must not change' } },
        { ref: 'voided-ref', deleted: true },
        { ref: 'deleted-ref', record: { memberName: 'Deleted' } },
        { ref: 'removed-ref', deleted: true },
        { ref: 'quarantined-ref', record: { memberName: 'Quarantined' } },
        { ref: 'live-ref', record: { memberName: 'Updated' } },
      ],
    }));
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(await all(
      kit.env.DB, 'SELECT * FROM passes WHERE id IN (?, ?, ?, ?, ?) ORDER BY id',
      [test.id, voided.id, deleted.id, removed.id, quarantined.id],
    )).toEqual(before);
    expect(kit.seams.applied.map((input) => input.passId)).toEqual([live.id]);
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.missing).toEqual([]);
  });

  it.each(['generation', 'disabled', 'mode', 'org', 'missing-context'] as const)(
    'rejects a queued webhook with stale %s before applying it',
    async (change) => {
      const { dto, secret } = await pushConn();
      const pass = await linkedPass(kit, dto.id, 'm-001');
      await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('queued')));
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('no job');
      if (change === 'generation') {
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [dto.id]);
      } else if (change === 'disabled') {
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [dto.id]);
      } else if (change === 'mode') {
        await run(kit.env.DB, "UPDATE connections SET mode = 'manual' WHERE id = ?", [dto.id]);
      } else if (change === 'org') {
        queued.orgId = (await makeOrg(kit)).id;
      } else {
        delete (queued as Partial<typeof queued>).generation;
      }
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      await processWebhook(kit.sctx, queued);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(kit.seams.missing).toEqual([]);
      expect(await all(kit.env.DB, "SELECT id FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'", [dto.id])).toEqual([]);
    },
  );
});

describe('POST /hooks/connections/:id', () => {
  it('answers 202 for a valid signature, 401 for an invalid one, with problem+json errors', async () => {
    const { dto, secret } = await pushConn();
    const app = createApp({ stores: fakeAuth().stores, clock: kit.clock });
    const url = `/hooks/connections/${dto.id}`;
    const good = await signedRequest(secret, event('evt-http'));
    const res = await app.request(url, good, kit.env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(kit.seams.jobs).toHaveLength(1);

    const bad = await signedRequest('whsec_nopenopenope0000', event('evt-http-2'));
    const denied = await app.request(url, bad, kit.env);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('content-type')).toContain('application/problem+json');
    expect(await denied.text()).not.toContain(secret);

    const unknown = await app.request(
      '/hooks/connections/nope',
      await signedRequest(secret, event('evt-http-3')),
      kit.env,
    );
    expect(unknown.status).toBe(404);
  });

  it('needs no session or CSRF token', async () => {
    const { dto, secret } = await pushConn();
    const app = createApp({ stores: fakeAuth().stores, clock: kit.clock });
    const res = await app.request(
      `/hooks/connections/${dto.id}`,
      await signedRequest(secret, event('evt-nosession')),
      kit.env,
    );
    expect(res.status).toBe(202);
  });
});
