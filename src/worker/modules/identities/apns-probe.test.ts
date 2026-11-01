import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeEnv } from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { createApp } from '../../app.ts';
import { all, first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { probeApns, runDailyApnsProbes } from './apns-probe.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const fake = fakeAuth();
const PASS_TYPE = 'pass.com.probe.t1';

type Reply = { status: number; reason?: string } | 'throw';
interface Seen {
  url: string;
  topic: string | null;
}

function fetcher(reply: Reply, seen: Seen[] = []): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        topic: new Headers(init?.headers).get('apns-topic'),
      });
      if (reply === 'throw') throw new Error('tls');
      return new Response(reply.reason ? JSON.stringify({ reason: reply.reason }) : '{}', {
        status: reply.status,
      });
    },
  } as unknown as Fetcher;
}

let env: AppEnv;
let app: ReturnType<typeof createApp>;
let identityId: string;

const withBinding = (f: Fetcher | undefined): AppEnv => ({ ...env, APNS_PROBE: f }) as AppEnv;
const ctxOf = (e: AppEnv) => createServiceContext(e);
const health = async () =>
  (
    await first<{ apns_health: string }>(
      env.DB,
      'SELECT apns_health FROM signing_identities WHERE id = ?',
      [identityId],
    )
  )?.apns_health;

beforeAll(async () => {
  const f = await createFixtureIdentity({
    passTypeIdentifier: PASS_TYPE,
    teamIdentifier: 'ACME123456',
  });
  env = await makeEnv({ SIGNER_PLATFORM_INTERMEDIATE: f.intermediate, KEK_V1 });
  app = createApp({ stores: fake.stores });
  const created = await app.request(
    '/api/v1/identities',
    {
      method: 'POST',
      headers: { ...fake.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'Probe',
        certificatePem: f.certificate,
        privateKeyPem: f.privateKey,
      }),
    },
    env,
  );
  identityId = ((await created.json()) as { id: string }).id;
  const patched = await app.request(
    `/api/v1/identities/${identityId}`,
    {
      method: 'PATCH',
      headers: { ...fake.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({ apnsBinding: 'APNS_PROBE' }),
    },
    env,
  );
  expect(patched.status).toBe(200);
});

describe('apns probe', () => {
  it('reports unavailable and leaves health unknown without a binding', async () => {
    const result = await probeApns(ctxOf(env), null, identityId);
    expect(result).toMatchObject({ health: 'unavailable', status: 0 });
    expect(await health()).toBe('unknown');
  });

  it.each([
    [{ status: 400, reason: 'BadDeviceToken' }, 'healthy'],
    [{ status: 400, reason: 'DeviceTokenNotForTopic' }, 'healthy'],
    [{ status: 403, reason: 'BadCertificate' }, 'failing'],
    [{ status: 403 }, 'failing'],
    [{ status: 400, reason: 'TopicDisallowed' }, 'failing'],
    [{ status: 403, reason: 'ExpiredProviderToken' }, 'failing'],
    ['throw', 'failing'],
  ] as [Reply, string][])('maps %j to %s', async (reply, expected) => {
    const seen: Seen[] = [];
    const result = await probeApns(ctxOf(withBinding(fetcher(reply, seen))), null, identityId);
    expect(result.health).toBe(expected);
    expect(await health()).toBe(expected);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.topic).toBe(PASS_TYPE);
    expect(seen[0]?.url).toContain(`/3/device/${'0'.repeat(64)}`);
  });

  it.each([
    [{ status: 429, reason: 'TooManyRequests' }],
    [{ status: 503, reason: 'ServiceUnavailable' }],
  ] as [Reply][])('leaves health unchanged on %j', async (reply) => {
    await probeApns(
      ctxOf(withBinding(fetcher({ status: 400, reason: 'BadDeviceToken' }))),
      null,
      identityId,
    );
    const result = await probeApns(ctxOf(withBinding(fetcher(reply))), null, identityId);
    expect(result.health).toBe('inconclusive');
    expect(await health()).toBe('healthy');
  });

  it('audits each probe and never touches registrations', async () => {
    const before = await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM registrations');
    await probeApns(
      ctxOf(withBinding(fetcher({ status: 403, reason: 'BadCertificate' }))),
      {
        type: 'user',
        id: 'admin-1',
      } as never,
      identityId,
    );
    const rows = await all<{ actor_type: string; detail: string }>(
      env.DB,
      `SELECT actor_type, detail FROM audit_log WHERE action = 'identity.apns_probe' AND target_id = ? ORDER BY id DESC LIMIT 1`,
      [identityId],
    );
    expect(rows[0]?.detail).toContain('BadCertificate');
    expect(await first(env.DB, 'SELECT COUNT(*) AS n FROM registrations')).toEqual(before);
  });

  it('daily run probes identities with a binding', async () => {
    const seen: Seen[] = [];
    await runDailyApnsProbes(
      ctxOf(withBinding(fetcher({ status: 400, reason: 'BadDeviceToken' }, seen))),
    );
    expect(seen.map((s) => s.topic)).toContain(PASS_TYPE);
    expect(await health()).toBe('healthy');
  });
});

describe('apns-check route', () => {
  const post = (headers: Record<string, string>, id = identityId) =>
    app.request(
      `/api/v1/identities/${id}/apns-check`,
      { method: 'POST', headers },
      withBinding(fetcher({ status: 400, reason: 'BadDeviceToken' })),
    );

  it('returns the result for an admin', async () => {
    const res = await post(fake.admin());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      health: 'healthy',
      status: 400,
      reason: 'BadDeviceToken',
    });
  });

  it('rejects non-admins, missing CSRF and unknown identities', async () => {
    expect((await post(fake.user())).status).toBe(403);
    const { cookie } = fake.admin();
    expect((await post({ cookie: cookie ?? '' })).status).toBe(403);
    expect((await post(fake.admin(), 'nope')).status).toBe(404);
  });
});
