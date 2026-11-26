import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhook } from '../../../../sdk/typescript/src/index.ts';
import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import {
  WEBHOOK_CAPTURE_LIMITS,
  type WebhookCaptureDto,
  WebhookCaptureSchema,
} from '../../../shared/contracts/webhook-captures.ts';
import { WEBHOOK_EVENT_TYPES, WebhookEventSchema } from '../../../shared/contracts/webhooks.ts';
import { firstFailure, verifySteps } from '../../../shared/webhook-verify.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { makeSandbox, startAndSettle } from '../developer/sandbox-test-fixtures.ts';
import { createFakeQueue } from '../passes/pass-test-fixtures.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { runLane } from './deliver.ts';
import { dispatchLane } from './dispatch.ts';
import { dailyWebhooks } from './jobs.ts';
import { seedEndpoint } from './webhooks-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const HOUR = 3_600_000;
const DAY = 86_400_000;

let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;
/** Every request that left the Worker: a capture endpoint must add none. */
let outbound: string[] = [];

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/'))
      return Response.json({ success: true });
    outbound.push(url);
    return realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  outbound = [];
  Object.assign(kit.env, { RL_WEBHOOK_OUT: fakeRateLimiter({ limit: 100_000 }) });
});

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(headers.cookie ? { origin: ORIGIN } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
type Json = any;
const call = async (
  m: string,
  p: string,
  h: Record<string, string>,
  b?: unknown,
): Promise<[number, Json]> => {
  const res = await send(m, p, h, b);
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : {}];
};

/** A person with a sandbox, whose Test key calls the API as a server would. */
async function sandbox() {
  const user = await makeUser(kit.f);
  const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
  const made = await makeSandbox(send, session.headers);
  if (!made.key || !made.templateId) throw new Error('A new sandbox has a key and a ticket.');
  const key = made.key;
  return {
    ...made,
    templateId: made.templateId,
    session,
    key: { authorization: `Bearer ${key.secret}` },
  };
}

/** The sandbox's capture endpoint and its secret. */
async function captureOf(s: Awaited<ReturnType<typeof sandbox>>) {
  const [status, body] = await call('POST', '/webhook-endpoints/capture', s.key, {});
  expect(status).toBe(200);
  const [, secret] = await call(
    'POST',
    `/webhook-endpoints/${body.endpoint.id}/captures/secret`,
    s.key,
  );
  return { id: body.endpoint.id as string, secret: secret.secret as string };
}

describe('provisioning', () => {
  it('gives a new sandbox a capture endpoint with its secret, and a retry makes no second', async () => {
    const s = await sandbox();
    const rows = await all<{ id: string; target: string; mode: string }>(
      kit.env.DB,
      'SELECT id, target, mode FROM webhook_endpoints WHERE org_id = ?',
      [s.orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: 'capture', mode: 'test' });
    const again = await startAndSettle(send, s.session.headers, 'POST', '/developer/sandbox', {
      turnstileToken: 'ok',
    });
    expect(again.status).toBe('succeeded');
    expect(
      (
        await first<{ n: number }>(
          kit.env.DB,
          'SELECT count(*) AS n FROM webhook_endpoints WHERE org_id = ?',
          [s.orgId],
        )
      )?.n,
    ).toBe(1);
  });

  it('backfills a sandbox made before captures existed, on the next call', async () => {
    const s = await sandbox();
    await run(kit.env.DB, 'DELETE FROM webhook_endpoints WHERE org_id = ?', [s.orgId]);
    const [status, body] = await call('POST', '/webhook-endpoints/capture', s.key, {});
    expect(status).toBe(201);
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.endpoint).toMatchObject({
      target: 'capture',
      mode: 'test',
      urlMasked: 'capture.invalid',
    });
    const [again, second] = await call('POST', '/webhook-endpoints/capture', s.key, {});
    expect([again, second.secret, second.endpoint.id]).toEqual([200, null, body.endpoint.id]);
  });
});

describe('capture only works in developer orgs, in Test', () => {
  it('refuses a standard org, in the API and in SQL', async () => {
    const org = await makeOrg(kit.f);
    const key = (
      await makeApiKey(kit.f, { scopes: ['webhooks:manage'], orgId: org.id, mode: 'test' })
    ).headers;
    const [status, body] = await call('POST', '/webhook-endpoints/capture', key, {});
    expect([status, body.code]).toEqual([409, 'CAPTURE_DEVELOPER_ONLY']);
    const insert = (orgId: string, mode: string) =>
      run(
        kit.env.DB,
        `INSERT INTO webhook_endpoints (id, org_id, mode, url, event_types, api_version, target, created_at, updated_at)
         VALUES (?, ?, ?, 'https://capture.invalid/', '["pass.issued"]', '2026-11-20', 'capture', 1, 1)`,
        [kit.f.ids.id(), orgId, mode],
      );
    await expect(insert(org.id, 'test')).rejects.toThrow(/developer org in Test/);
    const dev = await makeOrg(kit.f, { kind: 'developer' });
    await expect(insert(dev.id, 'live')).rejects.toThrow(/Live|developer org in Test/);
    await insert(dev.id, 'test');
  });

  it('keeps target and url of an endpoint fixed', async () => {
    const s = await sandbox();
    const { id } = await captureOf(s);
    await expect(
      run(kit.env.DB, "UPDATE webhook_endpoints SET target = 'url' WHERE id = ?", [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(kit.env.DB, "UPDATE webhook_endpoints SET url = 'https://example.com/' WHERE id = ?", [
        id,
      ]),
    ).rejects.toThrow(/no url/);
    const [status, body] = await call('PATCH', `/webhook-endpoints/${id}`, s.key, {
      url: 'https://example.com/x',
    });
    expect([status, body.code]).toEqual([422, 'CAPTURE_URL_FIXED']);
  });

  it('answers captures of a URL endpoint with a plain refusal', async () => {
    const s = await sandbox();
    const url = await seedEndpoint(kit.env.DB, { orgId: s.orgId, mode: 'test' });
    const [status, problem] = await call('GET', `/webhook-endpoints/${url}/captures`, s.key);
    expect([status, problem.code]).toEqual([409, 'NOT_A_CAPTURE_ENDPOINT']);
  });

  it('hides a sandbox from every other org', async () => {
    const mine = await sandbox();
    const theirs = await sandbox();
    const { id } = await captureOf(mine);
    const [status] = await call('GET', `/webhook-endpoints/${id}/captures`, theirs.key);
    expect(status).toBe(404);
    const [secret] = await call('POST', `/webhook-endpoints/${id}/captures/secret`, theirs.key);
    expect(secret).toBe(404);
  });
});

describe('one capture endpoint per org', () => {
  it('leaves one after concurrent creates, and SQL refuses a second', async () => {
    const s = await sandbox();
    await run(kit.env.DB, 'DELETE FROM webhook_endpoints WHERE org_id = ?', [s.orgId]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => call('POST', '/webhook-endpoints/capture', s.key, {})),
    );
    expect(results.every(([status]) => status === 200 || status === 201)).toBe(true);
    expect(results.filter(([status]) => status === 201)).toHaveLength(1);
    const rows = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM webhook_endpoints WHERE org_id = ? AND target = 'capture'",
      [s.orgId],
    );
    expect(rows).toHaveLength(1);
    expect(new Set(results.map(([, body]) => body.endpoint.id))).toEqual(new Set([rows[0]?.id]));
    await expect(
      run(
        kit.env.DB,
        `INSERT INTO webhook_endpoints (id, org_id, mode, url, event_types, api_version, target, created_at, updated_at)
         VALUES ('second', ?, 'test', 'https://capture.invalid/', '["pass.issued"]', '2026-11-20', 'capture', 1, 1)`,
        [s.orgId],
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('counts a capture create against the hourly create limit', async () => {
    const s = await sandbox();
    await run(kit.env.DB, 'DELETE FROM webhook_endpoints WHERE org_id = ?', [s.orgId]);
    await run(
      kit.env.DB,
      `INSERT INTO audit_log (at, org_id, actor_type, action, target_type, target_id, detail)
       SELECT ?, ?, 'system', 'webhook.endpoint.create', 'webhook_endpoint', 'x' || value, '{}'
       FROM json_each('[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]')`,
      [kit.clock.now(), s.orgId],
    );
    const [status, problem] = await call('POST', '/webhook-endpoints/capture', s.key, {});
    expect([status, problem.code]).toEqual([429, 'RATE_LIMITED']);
  });
});

describe('secret reveal', () => {
  it('is audited without the secret', async () => {
    const s = await sandbox();
    const { id, secret } = await captureOf(s);
    const rows = await all<{ action: string; detail: string; target_id: string }>(
      kit.env.DB,
      "SELECT action, detail, target_id FROM audit_log WHERE org_id = ? AND action = 'webhook.capture_secret.reveal'",
      [s.orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target_id).toBe(id);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

describe('erasing a pass', () => {
  it('erases what the sandbox captured about it, and only that', async () => {
    const s = await sandbox();
    const { id } = await captureOf(s);
    const sample = (
      (await (await send('GET', `/templates/${s.templateId}`, s.key)).json()) as {
        manifest: { sample?: object };
      }
    ).manifest.sample;
    const make = async () => {
      const res = await send('POST', '/passes', s.key, {
        templateId: s.templateId,
        input: sample ?? {},
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const gone = await make();
    const kept = await make();
    const insert = (passId: string, n: number) =>
      run(
        kit.env.DB,
        `INSERT INTO webhook_captures (id, endpoint_id, org_id, mode, event_id, event_type, trigger, headers, body, created_at)
         VALUES (?, ?, ?, 'test', 'e', 'pass.issued', 'event', '{}', ?, ?)`,
        [`${id}:p${n}`, id, s.orgId, JSON.stringify({ pass: { id: passId } }), kit.clock.now() + n],
      );
    await insert(gone, 1);
    await insert(kept, 2);
    await insert('x', 3);
    await run(
      kit.env.DB,
      "INSERT INTO webhook_captures (id, endpoint_id, org_id, mode, event_id, event_type, trigger, headers, body, created_at) VALUES (?, ?, ?, 'test', 'e', 'pass.issued', 'event', '{}', 'not json', ?)",
      [`${id}:raw`, id, s.orgId, kit.clock.now() + 4],
    );
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [gone]);
    const left = (
      await all<{ id: string }>(
        kit.env.DB,
        'SELECT id FROM webhook_captures WHERE id LIKE ? ORDER BY id',
        [`${id}:%`],
      )
    ).map((r) => r.id.split(':')[1]);
    expect(left).toEqual(['p2', 'p3', 'raw']);
  });
});

describe('send test event', () => {
  it('sends every event type: a signed capture that verifies, and nothing leaves', async () => {
    const s = await sandbox();
    const { id, secret } = await captureOf(s);
    const seen = new Set<string>();
    for (const type of WEBHOOK_EVENT_TYPES) {
      const [status, result] = await call('POST', `/webhook-endpoints/${id}/test`, s.key, { type });
      expect([type, status, result.ok, result.status]).toEqual([type, 200, true, 200]);
      const [, capture] = await call(
        'GET',
        `/webhook-endpoints/${id}/captures/${result.captureId}`,
        s.key,
      );
      const stored = WebhookCaptureSchema.parse(capture);
      const event = WebhookEventSchema.parse(JSON.parse(stored.body));
      expect(event.type).toBe(type);
      expect(stored.type).toBe(type);
      // A sample says so, and names no real order.
      if (type !== 'webhook.test')
        expect(JSON.parse(stored.body)).toMatchObject({
          sample: true,
          pass: { externalId: 'sample_order_1042' },
        });
      expect(stored.trigger).toBe('test');
      seen.add(type);
      const now = Math.floor(stored.createdAt / 1000);
      expect(
        firstFailure(
          await verifySteps({ headers: stored.headers, body: stored.body, secrets: [secret], now }),
        ),
      ).toBeNull();
      await expect(
        verifyWebhook(stored.body, stored.headers, secret, { now }),
      ).resolves.toMatchObject({ type });
    }
    expect([...seen]).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(outbound).toEqual([]);
  });

  it('keeps webhook.test working with no body at all', async () => {
    const s = await sandbox();
    const { id } = await captureOf(s);
    const [status, result] = await call('POST', `/webhook-endpoints/${id}/test`, s.key);
    expect([status, result.ok]).toEqual([200, true]);
    const [, page] = await call('GET', `/webhook-endpoints/${id}/captures`, s.key);
    expect(page.items.map((c: WebhookCaptureDto) => c.type)).toEqual(['webhook.test']);
  });

  it('sends samples to Test endpoints only', async () => {
    const live = await makeOrg(kit.f);
    const key = (
      await makeApiKey(kit.f, { scopes: ['webhooks:manage'], orgId: live.id, mode: 'live' })
    ).headers;
    const endpoint = await seedEndpoint(kit.env.DB, { orgId: live.id, mode: 'live' });
    const [status, problem] = await call('POST', `/webhook-endpoints/${endpoint}/test`, key, {
      type: 'pass.updated',
    });
    expect([status, problem.code]).toEqual([409, 'SAMPLE_EVENT_LIVE']);
  });
});

describe('real deliveries', () => {
  it('are stored on the capture endpoint when a pass changes, and replay signs the same bytes again', async () => {
    const s = await sandbox();
    const { id, secret } = await captureOf(s);
    const detail = await send('GET', `/templates/${s.templateId}`, s.key);
    const sample = ((await detail.json()) as { manifest: { sample?: Record<string, unknown> } })
      .manifest.sample;
    const queue = createFakeQueue();
    Object.assign(kit.env, { WEBHOOK_JOBS: queue });
    const created = await send('POST', '/passes', s.key, {
      templateId: s.templateId,
      input: sample ?? {},
    });
    expect(created.status).toBe(201);
    const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
    const lane = { endpointId: id, orgId: s.orgId, mode: 'test' } as const;
    await dispatchLane(ctx, lane);
    while (queue.sent.length > 0) await runLane(ctx, queue.sent.shift() as never);
    expect(outbound).toEqual([]);

    const [, page] = await call('GET', `/webhook-endpoints/${id}/captures`, s.key);
    const issued = page.items.find(
      (c: WebhookCaptureDto) => c.type === 'pass.issued',
    ) as WebhookCaptureDto;
    expect(issued).toMatchObject({ trigger: 'event', status: 200 });
    const delivery = await first<{ state: string; last_status: number }>(
      kit.env.DB,
      'SELECT state, last_status FROM webhook_deliveries WHERE endpoint_id = ?',
      [id],
    );
    expect(delivery).toEqual({ state: 'delivered', last_status: 200 });
    const now = Math.floor(issued.createdAt / 1000);
    expect(
      firstFailure(
        await verifySteps({ headers: issued.headers, body: issued.body, secrets: [secret], now }),
      ),
    ).toBeNull();

    kit.clock.advance(60_000);
    const [status, replay] = await call(
      'POST',
      `/webhook-endpoints/${id}/captures/${issued.id}/replay`,
      s.key,
    );
    expect(status).toBe(201);
    expect(replay).toMatchObject({ eventId: issued.eventId, body: issued.body, trigger: 'replay' });
    expect(replay.headers['x-passbook-signature']).not.toBe(issued.headers['x-passbook-signature']);
    expect(replay.headers['x-passbook-timestamp']).not.toBe(issued.headers['x-passbook-timestamp']);
    const at = Math.floor(replay.createdAt / 1000);
    expect(
      firstFailure(
        await verifySteps({
          headers: replay.headers,
          body: replay.body,
          secrets: [secret],
          now: at,
        }),
      ),
    ).toBeNull();
    expect(outbound).toEqual([]);
  });
});

/** Raw rows, as the delivery path writes them. */
async function fill(endpointId: string, orgId: string, n: number, at: number, label = 'c') {
  for (let from = 0; from < n; from += 50) {
    await kit.env.DB.batch(
      Array.from({ length: Math.min(50, n - from) }, (_, i) =>
        kit.env.DB.prepare(
          `INSERT INTO webhook_captures (id, endpoint_id, org_id, mode, event_id, event_type, trigger, headers, body, created_at)
           VALUES (?, ?, ?, 'test', 'e', 'pass.issued', 'event', '{}', '{}', ?)`,
        ).bind(
          `${endpointId}:${label}-${String(from + i).padStart(5, '0')}`,
          endpointId,
          orgId,
          at + from + i,
        ),
      ),
    );
  }
}
const countOf = async (endpointId: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM webhook_captures WHERE endpoint_id = ?',
      [endpointId],
    )
  )?.n;

describe('caps', () => {
  it('keeps the newest 200 per endpoint', async () => {
    const s = await sandbox();
    const { id } = await captureOf(s);
    await fill(id, s.orgId, WEBHOOK_CAPTURE_LIMITS.perEndpoint + 5, kit.clock.now());
    expect(await countOf(id)).toBe(200);
    const ids = (
      await all<{ id: string }>(
        kit.env.DB,
        'SELECT id FROM webhook_captures WHERE endpoint_id = ? ORDER BY id',
        [id],
      )
    ).map((r) => r.id);
    expect(ids[0]).toMatch(/:c-00005$/);
    expect(ids.at(-1)).toMatch(/:c-00204$/);
  });

  it('allows 600 an hour per org, then refuses the API and defers deliveries, until the next hour', async () => {
    const s = await sandbox();
    const { id } = await captureOf(s);
    // Three endpoints' worth, so pruning cannot hide the count.
    const at = Math.floor(kit.clock.now() / HOUR) * HOUR + 1000;
    await run(kit.env.DB, 'DELETE FROM webhook_capture_hours WHERE org_id = ?', [s.orgId]);
    await fill(id, s.orgId, 600, at);
    expect(
      (
        await first<{ n: number }>(
          kit.env.DB,
          'SELECT n FROM webhook_capture_hours WHERE org_id = ?',
          [s.orgId],
        )
      )?.n,
    ).toBe(600);
    kit.clock.set(at + 5000);
    const [status, problem] = await call('POST', `/webhook-endpoints/${id}/test`, s.key, {
      type: 'pass.issued',
    });
    expect([status, problem.code]).toEqual([429, 'RATE_LIMITED']);
    await expect(fill(id, s.orgId, 1, at + 10_000, 'x')).rejects.toThrow(/capture hourly limit/);
    expect(await countOf(id)).toBe(200);
    // A delivery waits instead of failing, and costs the endpoint nothing.
    const queue = createFakeQueue();
    Object.assign(kit.env, { WEBHOOK_JOBS: queue });
    const issued = await send('POST', '/passes', s.key, {
      templateId: s.templateId,
      input:
        (
          (await (await send('GET', `/templates/${s.templateId}`, s.key)).json()) as {
            manifest: { sample?: object };
          }
        ).manifest.sample ?? {},
    });
    expect(issued.status).toBe(201);
    const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
    await dispatchLane(ctx, { endpointId: id, orgId: s.orgId, mode: 'test' });
    while (queue.sent.length > 0) await runLane(ctx, queue.sent.shift() as never);
    const held = await first<{ state: string; last_error: string; attempts: number }>(
      kit.env.DB,
      'SELECT state, last_error, attempts FROM webhook_deliveries WHERE endpoint_id = ?',
      [id],
    );
    expect(held).toEqual({ state: 'pending', last_error: 'RATE_LIMITED', attempts: 0 });
    expect(
      (
        await first<{ c: number }>(
          kit.env.DB,
          'SELECT consecutive_failures AS c FROM webhook_endpoints WHERE id = ?',
          [id],
        )
      )?.c,
    ).toBe(0);
    // The next hour starts a new count.
    kit.clock.set(at + HOUR);
    const [again] = await call('POST', `/webhook-endpoints/${id}/test`, s.key, {
      type: 'pass.issued',
    });
    expect(again).toBe(200);
  });

  it('refuses a body over 256 KiB and takes one of exactly 256 KiB', async () => {
    const s = await sandbox();
    const { id } = await captureOf(s);
    const insert = (bytes: number) =>
      run(
        kit.env.DB,
        `INSERT INTO webhook_captures (id, endpoint_id, org_id, mode, event_id, event_type, trigger, headers, body, created_at)
         VALUES (?, ?, ?, 'test', 'e', 'pass.issued', 'event', '{}', ?, ?)`,
        [kit.f.ids.id(), id, s.orgId, 'a'.repeat(bytes), kit.clock.now()],
      );
    await insert(WEBHOOK_CAPTURE_LIMITS.maxBytes);
    await expect(insert(WEBHOOK_CAPTURE_LIMITS.maxBytes + 1)).rejects.toThrow();
    const { assertCaptureSize } = await import('./capture.ts');
    expect(() => assertCaptureSize('a'.repeat(WEBHOOK_CAPTURE_LIMITS.maxBytes))).not.toThrow();
    expect(() => assertCaptureSize('é'.repeat(WEBHOOK_CAPTURE_LIMITS.maxBytes / 2 + 1))).toThrow(
      /256 KiB/,
    );
  });

  it('refuses a capture on an endpoint that is not a capture endpoint', async () => {
    const s = await sandbox();
    const url = await seedEndpoint(kit.env.DB, { orgId: s.orgId, mode: 'test' });
    await expect(fill(url, s.orgId, 1, kit.clock.now())).rejects.toThrow(/not a capture endpoint/);
  });
});

describe('retention', () => {
  it('purges captures after 7 days with the daily job, and keeps younger ones', async () => {
    const s = await sandbox();
    const { id } = await captureOf(s);
    const now = kit.clock.now();
    await fill(id, s.orgId, 3, now - 8 * DAY, 'old');
    await fill(id, s.orgId, 3, now - 6 * DAY, 'new');
    expect(await countOf(id)).toBe(6);
    await dailyWebhooks({
      ...createJobContext(kit.env, 'test', { clock: kit.clock }),
      waitUntil: () => undefined,
    });
    const left = await all<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM webhook_captures WHERE endpoint_id = ? ORDER BY id',
      [id],
    );
    expect(left.map((r) => r.id.split(':')[1])).toEqual(['new-00000', 'new-00001', 'new-00002']);
    // Hourly counters older than two days go too.
    expect(
      (
        await first<{ n: number }>(
          kit.env.DB,
          'SELECT count(*) AS n FROM webhook_capture_hours WHERE org_id = ? AND hour < ?',
          [s.orgId, Math.floor(now / HOUR) - 48],
        )
      )?.n,
    ).toBe(0);
  });

  it('goes with the endpoint', async () => {
    const s = await sandbox();
    const { id } = await captureOf(s);
    await fill(id, s.orgId, 2, kit.clock.now());
    const [status] = await call('DELETE', `/webhook-endpoints/${id}`, s.key);
    expect(status).toBe(200);
    expect(await countOf(id)).toBe(0);
  });
});
