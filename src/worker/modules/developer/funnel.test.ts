import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { DeveloperFunnelSchema } from '../../../shared/contracts/developer.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { percentile } from '../metrics/developer-funnel.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { clampViewedAt } from './funnel.ts';
import { makeSandbox, startAndSettle } from './sandbox-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const DAY = 86_400_000;
/** Cloudflare's always-pass test secret. */
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = TURNSTILE_TEST_SECRET;
  (kit.env as { EVENTS: unknown }).EVENTS = {
    writeDataPoint: (p: (typeof points)[number]) => points.push(p),
  };
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
    return realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(headers.cookie ? { origin: ORIGIN } : {}),
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

/** `send` for the paths the sandbox helpers use: they name `/developer/...` and the app mounts it under `/api/v1`. */
const api = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  send(method, `/api/v1${path}`, headers, body);

async function person(withSandbox: boolean, viewedAt?: number) {
  const user = await makeUser(kit.f);
  const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
  if (!withSandbox) return { user, headers: session.headers, made: null };
  const made = await makeSandbox(api, session.headers, {
    turnstileToken: 'ok',
    ...(viewedAt === undefined ? {} : { viewedAt }),
  });
  return {
    user,
    headers: session.headers,
    made,
    key: { authorization: `Bearer ${made.key?.secret}` },
  };
}

const funnel = (orgId: string) =>
  first<Record<string, number | null>>(
    kit.env.DB,
    `SELECT quickstart_viewed_at, first_call_at, first_pass_at, first_preview_at
     FROM developer_sandboxes WHERE org_id = ?`,
    [orgId],
  );
const beacon = (headers: Record<string, string>, body: unknown) =>
  send('POST', '/developers/beacon', headers, body);

type Person = Awaited<ReturnType<typeof person>>;

/** A test pass made with the sandbox's key, the way a console-first person would. Its id. */
async function makeTestPass(p: Person): Promise<string> {
  const detail = (await (
    await send('GET', `/api/v1/templates/${p.made?.templateId}`, p.key ?? {})
  ).json()) as {
    manifest: { sample?: Record<string, unknown> };
  };
  const res = await send('POST', '/api/v1/passes', p.key ?? {}, {
    templateId: p.made?.templateId,
    input: detail.manifest.sample ?? {},
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const events = (name: string) => points.filter((x) => x.blobs[0] === name);
const metrics = async () => {
  const admin = await makeSession(kit.f, { userId: (await makeUser(kit.f)).id, roles: ['admin'] });
  const res = await send('GET', '/api/v1/metrics/platform/developer', admin.headers);
  return DeveloperFunnelSchema.parse(await res.json());
};

describe('clampViewedAt', () => {
  it('holds a page view to the last 24 hours and never after now', () => {
    const now = 10 * DAY;
    expect(clampViewedAt(now - 1000, now)).toBe(now - 1000);
    expect(clampViewedAt(now - 3 * DAY, now)).toBe(now - DAY);
    expect(clampViewedAt(now + 5000, now)).toBe(now);
  });
});

describe('percentile', () => {
  it('is the nearest rank of an ascending list, null for none', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe('sandbox create carries the page view', () => {
  it('stamps quickstart_viewed_at, clamped to 24 hours', async () => {
    const recent = await person(true, kit.clock.now() - 90_000);
    expect((await funnel(recent.made?.orgId ?? ''))?.quickstart_viewed_at).toBe(
      kit.clock.now() - 90_000,
    );
    const old = await person(true, kit.clock.now() - 9 * DAY);
    expect((await funnel(old.made?.orgId ?? ''))?.quickstart_viewed_at).toBe(kit.clock.now() - DAY);
    const none = await person(true);
    expect((await funnel(none.made?.orgId ?? ''))?.quickstart_viewed_at).toBeNull();
  });
});

describe('POST /developers/beacon', () => {
  it('is for a signed-in person', async () => {
    expect((await beacon({}, { step: 'view' })).status).toBe(401);
    const p = await person(true);
    const noCsrf = { cookie: p.headers.cookie ?? '', 'sec-fetch-site': 'cross-site' };
    expect((await beacon(noCsrf, { step: 'view' })).status).toBe(403);
  });

  it('refuses a body that is not a step', async () => {
    const p = await person(true);
    expect((await beacon(p.headers, { step: 'purchase' })).status).toBe(422);
    expect((await beacon(p.headers, { step: 'fail', code: 'has a space' })).status).toBe(422);
  });

  it('does nothing for a person with no sandbox', async () => {
    const p = await person(false);
    const before = points.length;
    expect((await beacon(p.headers, { step: 'view' })).status).toBe(200);
    expect(points.length).toBe(before);
  });

  it('stamps view once, and a pass only when one exists', async () => {
    const p = await person(true);
    const orgId = p.made?.orgId ?? '';
    expect((await beacon(p.headers, { step: 'view' })).status).toBe(200);
    const viewed = (await funnel(orgId))?.quickstart_viewed_at;
    expect(viewed).toBe(kit.clock.now());
    kit.clock.advance(5000);
    await beacon(p.headers, { step: 'view' });
    expect((await funnel(orgId))?.quickstart_viewed_at).toBe(viewed);

    // The page says it ran; no pass exists, so nothing is claimed.
    await beacon(p.headers, { step: 'run' });
    expect((await funnel(orgId))?.first_pass_at).toBeNull();
    await beacon(p.headers, { step: 'live' });
    expect((await funnel(orgId))?.first_preview_at).toBeNull();

    const sample = (
      (await (
        await send('GET', `/api/v1/templates/${p.made?.templateId}`, p.key ?? {})
      ).json()) as {
        manifest: { sample?: Record<string, unknown> };
      }
    ).manifest.sample;
    const created = await send('POST', '/api/v1/passes', p.key ?? {}, {
      templateId: p.made?.templateId,
      input: sample ?? {},
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const passAt = (
      await first<{ at: number }>(
        kit.env.DB,
        'SELECT MIN(created_at) AS at FROM passes WHERE org_id = ?',
        [orgId],
      )
    )?.at;
    kit.clock.advance(7000);
    await beacon(p.headers, { step: 'run' });
    const after = await funnel(orgId);
    expect(after?.first_pass_at).toBe(passAt);
    expect(after?.first_call_at ?? 0).toBeGreaterThan(0);
    await beacon(p.headers, { step: 'live' });
    expect((await funnel(orgId))?.first_preview_at).toBe(kit.clock.now());
    // Set once: a later run changes nothing.
    kit.clock.advance(9000);
    await beacon(p.headers, { step: 'run' });
    await beacon(p.headers, { step: 'live' });
    expect(await funnel(orgId)).toEqual({
      ...after,
      first_preview_at: after?.first_preview_at ?? kit.clock.now() - 9000,
    });
  });

  it('carries only the org id: no person, pass, key or address reaches an event', async () => {
    const p = await person(true, kit.clock.now() - 30_000);
    const orgId = p.made?.orgId ?? '';
    const passId = await makeTestPass(p);
    expect(
      (
        await send('PATCH', `/api/v1/passes/${passId}`, p.key ?? {}, {
          input: { admission: 'VIP' },
        })
      ).status,
    ).toBe(200);
    // The pass's own events (platform ones) are not the funnel's: count from here.
    points.length = 0;
    await beacon(p.headers, { step: 'view' });
    await beacon(p.headers, { step: 'run' });
    await beacon(p.headers, { step: 'change' });
    await beacon(p.headers, { step: 'fail', code: 'TEMPLATE_RELEASE_REQUIRED' });
    expect(points.length).toBeGreaterThanOrEqual(4);
    const everything = JSON.stringify(points);
    for (const secret of [
      p.user.id,
      p.made?.id,
      p.made?.key?.id,
      p.made?.key?.secret,
      p.made?.templateId,
    ])
      expect(everything, String(secret)).not.toContain(String(secret));
    const email = await first<{ primary_email: string }>(
      kit.env.DB,
      'SELECT primary_email FROM users WHERE id = ?',
      [p.user.id],
    );
    expect(everything).not.toContain(email?.primary_email ?? 'no-email');
    for (const point of points) {
      expect(point.indexes).toEqual([orgId]);
      expect(point.blobs[0]).toMatch(/^dev\./);
      expect(point.blobs[1]).toBe(orgId);
      // templateId and identityId slots stay empty.
      expect([point.blobs[2], point.blobs[3]]).toEqual(['', '']);
    }
    expect(points.find((x) => x.blobs[0] === 'dev.fail')?.blobs[4]).toBe(
      'TEMPLATE_RELEASE_REQUIRED',
    );
  });

  it('writes the time to first pass once, even when run beacons race', async () => {
    const p = await person(true, kit.clock.now() - 60_000);
    const orgId = p.made?.orgId ?? '';
    const sample = (
      (await (
        await send('GET', `/api/v1/templates/${p.made?.templateId}`, p.key ?? {})
      ).json()) as {
        manifest: { sample?: Record<string, unknown> };
      }
    ).manifest.sample;
    await send('POST', '/api/v1/passes', p.key ?? {}, {
      templateId: p.made?.templateId,
      input: sample ?? {},
    });
    points.length = 0;
    await Promise.all([
      beacon(p.headers, { step: 'run' }),
      beacon(p.headers, { step: 'run' }),
      beacon(p.headers, { step: 'live' }),
    ]);
    await beacon(p.headers, { step: 'run' });
    const ttfp = points.filter((x) => x.blobs[0] === 'dev.ttfp');
    expect(ttfp).toHaveLength(1);
    const row = await funnel(orgId);
    expect(ttfp[0]?.doubles[0]).toBe((row?.first_pass_at ?? 0) - (row?.quickstart_viewed_at ?? 0));
  });
});

describe('what the funnel counts', () => {
  it('leaves a pass made before the quickstart view out of time to first pass', async () => {
    const p = await person(true);
    const orgId = p.made?.orgId ?? '';
    await makeTestPass(p);
    kit.clock.advance(5_000);
    const before = await metrics();
    points.length = 0;
    await beacon(p.headers, { step: 'view' });
    await beacon(p.headers, { step: 'run' });
    const row = await funnel(orgId);
    // The columns say what happened; the sample would be negative, so none is written or counted.
    expect((row?.first_pass_at ?? 0) < (row?.quickstart_viewed_at ?? 0)).toBe(true);
    expect(events('dev.ttfp')).toHaveLength(0);
    const after = await metrics();
    expect(after.ttfpSamples).toBe(before.ttfpSamples);
    expect(after.ttfpP50Ms).toBe(before.ttfpP50Ms);
    expect(after.viewed).toBe(before.viewed + 1);
  });

  it('takes `live` before `run`: it finds the pass and stamps both', async () => {
    const p = await person(true, kit.clock.now() - 30_000);
    const orgId = p.made?.orgId ?? '';
    await makeTestPass(p);
    await beacon(p.headers, { step: 'live' });
    const row = await funnel(orgId);
    expect(row?.first_pass_at).not.toBeNull();
    expect(row?.first_preview_at).toBe(kit.clock.now());
  });

  it('writes one event per set-once step however often the beacon is replayed', async () => {
    const p = await person(true);
    points.length = 0;
    for (let i = 0; i < 4; i++) await beacon(p.headers, { step: 'view' });
    expect(events('dev.view')).toHaveLength(1);
    await makeTestPass(p);
    for (let i = 0; i < 3; i++) {
      await beacon(p.headers, { step: 'run' });
      await beacon(p.headers, { step: 'live' });
    }
    expect(events('dev.run')).toHaveLength(1);
    expect(events('dev.live')).toHaveLength(1);
  });

  it('writes `dev.sandbox` once: a retry or a repair makes none', async () => {
    points.length = 0;
    const p = await person(true);
    expect(events('dev.sandbox')).toHaveLength(1);
    const again = await startAndSettle(api, p.headers, 'POST', '/developer/sandbox', {
      turnstileToken: 'ok',
    });
    expect(again.status).toBe('succeeded');
    expect(events('dev.sandbox')).toHaveLength(1);
  });

  it('counts `change` and `home` only when the database shows them, and a failure by a known code', async () => {
    const p = await person(true);
    points.length = 0;
    await beacon(p.headers, { step: 'change' });
    await beacon(p.headers, { step: 'home' });
    expect(events('dev.change')).toHaveLength(0);
    expect(events('dev.home')).toHaveLength(0);
    await beacon(p.headers, { step: 'fail', code: 'MADE_UP_BY_ME' });
    expect(events('dev.fail').map((e) => e.blobs[4])).toEqual(['OTHER']);
  });

  it('keeps the first call as stamped when the request log is purged', async () => {
    const p = await person(true);
    const orgId = p.made?.orgId ?? '';
    await makeTestPass(p);
    await beacon(p.headers, { step: 'run' });
    const stamped = (await funnel(orgId))?.first_call_at;
    expect(stamped).not.toBeNull();
    await run(kit.env.DB, 'DELETE FROM request_log WHERE org_id = ?', [orgId]);
    kit.clock.advance(8 * DAY);
    await beacon(p.headers, { step: 'view' });
    expect((await funnel(orgId))?.first_call_at).toBe(stamped);
  });
});

describe('GET /metrics/platform/developer', () => {
  it('is for platform admins', async () => {
    const user = await makeUser(kit.f);
    const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    expect(
      (await send('GET', '/api/v1/metrics/platform/developer', session.headers)).status,
    ).toBeGreaterThanOrEqual(401);
  });

  it('counts steps and takes percentiles from the page view to the first pass', async () => {
    const admin = await makeSession(kit.f, {
      userId: (await makeUser(kit.f)).id,
      roles: ['admin'],
    });
    const res = await send('GET', '/api/v1/metrics/platform/developer', admin.headers);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = DeveloperFunnelSchema.parse(await res.json());
    expect(body.windowDays).toBe(30);
    expect(body.passed).toBeLessThanOrEqual(body.viewed + body.sandboxes);
    expect(body.ttfpSamples).toBeGreaterThan(0);
    expect(body.ttfpP50Ms).not.toBeNull();
    expect(body.ttfpP90Ms ?? 0).toBeGreaterThanOrEqual(body.ttfpP50Ms ?? 0);
    // Counts and times only.
    expect(Object.values(body).every((v) => v === null || typeof v === 'number')).toBe(true);
  });
});
