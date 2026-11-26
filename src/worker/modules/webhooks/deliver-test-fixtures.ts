import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { recordPassEvent } from '../events/record.ts';
import { createFakeQueue, type FakeQueue } from '../passes/pass-test-fixtures.ts';
import { type ScanKit, setupScanKit } from '../scan/test-kit.ts';
import { runLane } from './deliver.ts';
import { dispatchLane } from './dispatch.ts';
import { resetKickMemo } from './kick.ts';
import { clearResolverMemo } from './resolver-memo.ts';
import { sealSecret } from './secrets.ts';
import { seedEndpoint } from './webhooks-test-fixtures.ts';

export interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface Net {
  /** POSTs to receivers, in order. */
  calls: Call[];
  /** DNS answers by host (A records); anything not listed resolves to a public address. */
  dns: Record<string, string[]>;
  respond: (call: Call) => Response | Promise<Response>;
  restore(): void;
}

/** Stubs globalThis.fetch for DoH and receivers. Call `restore` in afterEach. */
export function stubNet(): Net {
  const original = globalThis.fetch;
  const net: Net = {
    calls: [],
    dns: {},
    respond: () => new Response('ok', { status: 200 }),
    restore: () => {
      globalThis.fetch = original;
      clearResolverMemo();
      resetKickMemo();
    },
  };
  clearResolverMemo();
  resetKickMemo();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const q = new URL(url).searchParams;
      const host = q.get('name') ?? '';
      const data = q.get('type') === 'A' ? (net.dns[host] ?? ['93.184.216.34']) : [];
      return new Response(JSON.stringify({ Answer: data.map((d) => ({ type: 1, data: d })) }), {
        headers: { 'content-type': 'application/dns-json' },
      });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call = { url, headers, body: String(init?.body ?? '') };
    net.calls.push(call);
    return net.respond(call);
  }) as typeof fetch;
  return net;
}

export interface Rig {
  kit: ScanKit;
  /** The `passbook-webhooks` queue: lane messages land here, never on `kit.queue` (passbook-jobs). */
  hooks: FakeQueue;
  ctx: ServiceContext;
  db: D1Database;
  orgId: string;
}

export async function setupRig(): Promise<Rig> {
  const kit = await setupScanKit();
  const hooks = createFakeQueue();
  Object.assign(kit.env, {
    WEBHOOK_JOBS: hooks,
    RL_WEBHOOK_HOST: fakeRateLimiter({ limit: 100_000 }),
    RL_WEBHOOK_HOST_ORG: fakeRateLimiter({ limit: 100_000 }),
  });
  return { kit, hooks, ctx: jobCtxOf(kit), db: kit.env.DB, orgId: kit.org.id };
}

/** A raw envelope-encrypted secret, as the rotate grant would store it. */
export async function seedSecret(
  rig: Rig,
  e: {
    endpointId: string;
    orgId?: string;
    mode?: Mode;
    id?: string;
    value: string;
    expiresAt?: number;
  },
): Promise<string> {
  const orgId = e.orgId ?? rig.orgId;
  const mode = e.mode ?? 'live';
  const id = e.id ?? `sec-${Math.random().toString(36).slice(2, 8)}`;
  const env = await sealSecret(await loadKekRing(rig.kit.env), e.value, {
    secretId: id,
    orgId,
    endpointId: e.endpointId,
    mode,
  });
  await run(
    rig.db,
    `INSERT INTO webhook_endpoint_secrets (id, endpoint_id, org_id, mode, kek_version, iv, wrapped_dek,
       ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      id,
      e.endpointId,
      orgId,
      mode,
      env.kekVersion,
      env.iv,
      env.wrappedDek,
      env.ciphertext,
      e.expiresAt ?? null,
    ],
  );
  return id;
}

/** An endpoint with a secret. Create it before the pass so the trigger fans out to it. */
export async function endpointWithSecret(
  rig: Rig,
  seed: Parameters<typeof seedEndpoint>[1] & { secret?: string },
): Promise<string> {
  const id = await seedEndpoint(rig.db, seed);
  await seedSecret(rig, {
    endpointId: id,
    orgId: seed.orgId,
    mode: seed.mode ?? 'live',
    value: seed.secret ?? 'whsec_test',
  });
  return id;
}

export const deliveryOf = (db: D1Database, endpointId: string, seq?: number) =>
  first<{
    event_seq: number;
    state: string;
    attempts: number;
    next_at: number;
    last_status: number | null;
    last_error: string | null;
    finished_at: number | null;
  }>(
    db,
    `SELECT event_seq, state, attempts, next_at, last_status, last_error, finished_at
     FROM webhook_deliveries WHERE endpoint_id = ? ${seq === undefined ? '' : 'AND event_seq = ?'}
     ORDER BY event_seq LIMIT 1`,
    seq === undefined ? [endpointId] : [endpointId, seq],
  );

export const statesOf = (db: D1Database, endpointId: string) =>
  all<{ state: string; n: number }>(
    db,
    'SELECT state, count(*) AS n FROM webhook_deliveries WHERE endpoint_id = ? GROUP BY state ORDER BY state',
    [endpointId],
  );

export const endpointOf = (db: D1Database, id: string) =>
  first<{
    status: string;
    consecutive_failures: number;
    failing_since: number | null;
    lane_token: string | null;
    lane_until: number | null;
    last_success_at: number | null;
  }>(
    db,
    `SELECT status, consecutive_failures, failing_since, lane_token, lane_until, last_success_at
     FROM webhook_endpoints WHERE id = ?`,
    [id],
  );

/** Runs every queued `webhook.deliver` message, including the continuations they enqueue. */
export async function drain(rig: Rig, max = 50, timeoutMs?: number): Promise<number> {
  let handled = 0;
  for (let i = 0; i < max; i++) {
    const msg = rig.hooks.sent.shift() as
      | { kind: string; endpointId: string; orgId: string; mode: Mode; lane: string }
      | undefined;
    if (!msg) return handled;
    if (msg.kind === 'webhook.deliver') {
      await runLane(rig.ctx, msg as never, timeoutMs);
      handled++;
    }
  }
  throw new Error('queue did not drain');
}

/** `n` more journal rows on a pass, each a distinct event for every subscribed endpoint. */
export async function addEvents(rig: Rig, passId: string, n: number, orgId = rig.orgId) {
  for (let i = 0; i < n; i++)
    await recordPassEvent(rig.kit.ctx, {
      orgId,
      passId,
      mode: 'live',
      kind: 'pass.updated',
      data: { cause: 'publish', version: i + 2 },
    });
}

export const laneOf = (rig: Rig, endpointId: string, mode: Mode = 'live') => ({
  endpointId,
  orgId: rig.orgId,
  mode,
});

/** Claims the lane, then runs it and every continuation. */
export async function deliverNow(rig: Rig, endpointId: string, timeoutMs?: number) {
  const claimed = await dispatchLane(rig.ctx, laneOf(rig, endpointId));
  await drain(rig, 50, timeoutMs);
  return claimed;
}

/** A clean slate between tests: no endpoints (their deliveries, secrets and attempts cascade). */
export async function reset(rig: Rig) {
  await run(rig.db, 'DELETE FROM webhook_endpoints');
  rig.hooks.sent.length = 0;
}
