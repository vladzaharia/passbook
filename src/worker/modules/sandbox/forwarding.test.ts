import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { editFixedColumns, makeUser, type SessionFixture } from '../../../../test/helpers/index.ts';
import {
  CapturedEmailDetailSchema,
  CapturedEmailListSchema,
  ProblemSchema,
} from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { enqueueBundleEmail } from '../bundles/email-queue.ts';
import { type BundleDto, createBundle } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { reassignHolder } from '../holders/service.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { overrideDeps } from '../passes/deps.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { deleteObjects, deletePassRows } from '../passes/repo-ops-retention.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import { expiredTestPasses } from './repo.ts';
import { sendCapturedToMe } from './service.ts';
import {
  inboxApp,
  inboxAuthority,
  inboxHeaders,
  inboxMember,
  scopedInboxPath,
} from './test-tenant-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const ADMIN_EMAIL = 'forwarding-admin@example.com';
const actor = { type: 'user', id: 'admin-1' } as const;
// A holder change without tenant authority is a system operation.
const system = { type: 'system', id: null } as const;
let adminSession: SessionFixture;
let app: OpenAPIHono<AppBindings>;
let kit: Kit;

beforeAll(async () => {
  kit = await setupKit();
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
  await makeUser(kit.fx, { id: actor.id, primaryEmail: ADMIN_EMAIL });
  adminSession = (await inboxMember(kit, actor.id, kit.org.id, 'org_admin', ['admin', 'user']))
    .session;
  app = inboxApp(kit);
});

type Headers = Record<string, string>;
const admin = () => inboxHeaders(adminSession);
const api = async (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${scopedInboxPath(path, kit.org.id)}`, init, kit.env);
const send = (id: string, headers = admin()) =>
  api(`/test-inbox/${id}/send-to-me`, { method: 'POST', headers });
const detail = async (id: string) => {
  const response = await api(`/test-inbox/${id}`, { headers: admin() });
  expect(response.status).toBe(200);
  return CapturedEmailDetailSchema.parse(await response.json());
};
const uniqueEmail = () => `${kit.ctx.ids.token(8).toLowerCase()}@example.com`;

type Capture = { id: string; passes: Pass[]; to: string };
type PassCapture = Capture & { kind: 'pass' };
type BundleCapture = Capture & { kind: 'bundle'; token: string; bundle: BundleDto };

function testPass(to: string): Promise<Pass> {
  return kit.pass({ mode: 'test', memberName: 'Forwarding holder', holderEmail: to });
}

async function captured(outboxId: string): Promise<string> {
  await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
  const row = await first<{ id: string }>(
    kit.env.DB,
    'SELECT id FROM captured_emails WHERE outbox_id = ?',
    [outboxId],
  );
  if (!row) throw new Error('capture missing');
  return row.id;
}

async function capturePass(attached = false): Promise<PassCapture> {
  const to = uniqueEmail();
  const pass = await testPass(to);
  const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
    passId: pass.id,
    to,
    attach: attached,
    expected: pass,
  });
  return { kind: 'pass', id: await captured(outboxId), passes: [pass], to };
}

async function captureBundle(): Promise<BundleCapture> {
  const to = uniqueEmail();
  const passes = [await testPass(to), await testPass(to)];
  const bundle = await createBundle(
    jobCtxOf(kit),
    { type: 'system', id: null },
    'test',
    {
      orgId: kit.org.id,
      passIds: passes.map((pass) => pass.id),
      name: 'Forwarding bundle',
      holderEmail: to,
    },
    { kind: 'system' },
  );
  const token = bundle.url.split('/b/')[1] ?? '';
  const { outboxId } = await enqueueBundleEmail(jobCtxOf(kit), bundle.id, to, {
    token,
    holderEmail: to,
  });
  return { kind: 'bundle', id: await captured(outboxId), passes, to, token, bundle };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The first request has crossed the provider boundary but has not yet received an acknowledgement. */
function pauseProvider() {
  const entered = deferred();
  const release = deferred();
  const original = kit.mailer.send.bind(kit.mailer);
  const spy = vi.spyOn(kit.mailer, 'send').mockImplementationOnce(async (message) => {
    entered.resolve();
    await release.promise;
    return original(message);
  });
  return { entered, release, spy };
}

async function waitForProvider(entered: Promise<void>, request: Promise<Response>) {
  await Promise.race([
    entered,
    request.then((response) => {
      throw new Error(`forward stopped before provider: ${response.status}`);
    }),
  ]);
}

/** Race the reservation or final provider read, after the capture snapshot was validated. */
function raceForward(
  mutate: () => Promise<void>,
  boundary: 'reservation' | 'provider' = 'reservation',
): { ctx: ServiceContext; intercepted: () => boolean } {
  let invoked = false;
  const sqls = new WeakMap<object, string>();
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      // The reservation commits as a grant batch: mutate just before it when it holds the insert.
      if (prop === 'batch' && boundary === 'reservation')
        return async (statements: D1PreparedStatement[]) => {
          if (
            !invoked &&
            statements.some((st) =>
              /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+sandbox_forwards\b/i.test(sqls.get(st) ?? ''),
            )
          ) {
            invoked = true;
            await mutate();
          }
          return target.batch(statements);
        };
      if (prop === 'prepare')
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
            const proxy: D1PreparedStatement = new Proxy(statement, {
              get(inner, key) {
                if (key === 'bind') return (...args: unknown[]) => wrap(inner.bind(...args));
                if (
                  key === 'first' &&
                  (boundary === 'reservation'
                    ? /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+sandbox_forwards\b/i.test(sql)
                    : /FROM\s+captured_emails\s+c\s+JOIN\s+sandbox_forwards/i.test(sql))
                ) {
                  return async (column?: string) => {
                    if (!invoked) {
                      invoked = true;
                      await mutate();
                    }
                    return column === undefined ? inner.first() : inner.first(column);
                  };
                }
                const value = Reflect.get(inner, key, inner);
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
            sqls.set(proxy, sql);
            return proxy;
          };
          return wrap(target.prepare(sql));
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  overrideDeps(env, { mailer: kit.mailer, registry: kit.registry, apns: kit.apns });
  return { ctx: { ...jobCtxOf(kit), env }, intercepted: () => invoked };
}

async function expectProblem(response: Response, secrets: string[] = []) {
  expect(response.status).toBeGreaterThanOrEqual(400);
  const raw = await response.text();
  ProblemSchema.parse(JSON.parse(raw));
  for (const secret of secrets) expect(raw).not.toContain(secret);
}

describe('durable test inbox forwarding', () => {
  it('persists the acknowledged pass send and keeps content, credentials and destination out of the list', async () => {
    const fixture = await capturePass(true);
    const pass = fixture.passes[0]!;
    const before = await detail(fixture.id);
    expect(before.forwarding).toBe('none');
    expect(before.html).toContain(pass.downloadToken);
    const object = await kit.env.BUCKET.get(pass.objectKey);
    if (!object) throw new Error('pass attachment missing');
    const attachment = new Uint8Array(await object.arrayBuffer());
    const spy = vi.spyOn(kit.mailer, 'send');
    try {
      const response = await send(fixture.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ to: ADMIN_EMAIL });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(kit.mailer.sent.at(-1)).toMatchObject({
        to: ADMIN_EMAIL,
        subject: `[Test] ${before.subject}`,
        html: before.html,
        text: before.text,
        attachments: [
          { filename: 'pass.pkpass', type: 'application/vnd.apple.pkpass', content: attachment },
        ],
      });
      const rows = await all<{
        id: string;
        capture_id: string;
        actor_id: string;
        email: string;
        state: string;
        created_at: number;
        finished_at: number | null;
      }>(
        kit.env.DB,
        'SELECT id, capture_id, actor_id, email, state, created_at, finished_at FROM sandbox_forwards WHERE capture_id = ?',
        [fixture.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        capture_id: fixture.id,
        actor_id: actor.id,
        email: ADMIN_EMAIL,
        state: 'sent',
      });
      expect(rows[0]!.created_at).toBeGreaterThan(0);
      expect(rows[0]!.finished_at).not.toBeNull();
      expect(
        await all(kit.env.DB, 'SELECT pass_id FROM sandbox_forward_passes WHERE forward_id = ?', [
          rows[0]!.id,
        ]),
      ).toEqual([{ pass_id: pass.id }]);

      const freshApp = inboxApp(kit);
      const freshResponse = await freshApp.request(
        `${ORIGIN}/api/v1${scopedInboxPath(`/test-inbox/${fixture.id}`, kit.org.id)}`,
        { headers: admin() },
        kit.env,
      );
      expect(freshResponse.status).toBe(200);
      expect(CapturedEmailDetailSchema.parse(await freshResponse.json()).forwarding).toBe('sent');
      // A sent copy does not block another explicit send.
      expect((await send(fixture.id)).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);

      const listResponse = await api('/test-inbox?limit=200', { headers: admin() });
      const raw = (await listResponse.json()) as { items: Record<string, unknown>[] };
      CapturedEmailListSchema.parse(raw);
      const item = raw.items.find((entry) => entry.id === fixture.id);
      expect(item).toBeDefined();
      expect(item).toMatchObject({ to: fixture.to, passId: pass.id });
      expect(item).not.toHaveProperty('html');
      expect(item).not.toHaveProperty('text');
      expect(item).not.toHaveProperty('intent');
      expect(item).not.toHaveProperty('email');
      const serialized = JSON.stringify(item);
      for (const secret of [
        ADMIN_EMAIL,
        pass.downloadToken,
        pass.authToken,
        before.html,
        before.text,
        '/p/',
        '/b/',
      ])
        expect(serialized).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the verified primary email first, or a verified secondary when the primary is unverified', async () => {
    const firstUser = await makeUser(kit.fx, { primaryEmail: uniqueEmail() });
    const earlier = uniqueEmail();
    await run(
      kit.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
      [earlier, firstUser.id, kit.clock.now() - 1000],
    );
    const secondUser = await makeUser(kit.fx, { primaryEmail: uniqueEmail(), verified: false });
    const secondary = uniqueEmail();
    await run(
      kit.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
      [secondary, secondUser.id, kit.clock.now()],
    );
    const spy = vi.spyOn(kit.mailer, 'send');
    try {
      for (const [user, expected] of [
        [firstUser, firstUser.primaryEmail],
        [secondUser, secondary],
      ] as const) {
        const fixture = await capturePass();
        const headers = inboxHeaders((await inboxMember(kit, user.id)).session);
        const response = await send(fixture.id, headers);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ to: expected });
        expect(kit.mailer.sent.at(-1)?.to).toBe(expected);
        expect((await detail(fixture.id)).forwarding).toBe('sent');
        expect(
          await first(
            kit.env.DB,
            'SELECT actor_id, email, state FROM sandbox_forwards WHERE capture_id = ?',
            [fixture.id],
          ),
        ).toEqual({ actor_id: user.id, email: expected, state: 'sent' });
      }
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('allows another send after the verified address of a sent copy was removed', async () => {
    const user = await makeUser(kit.fx, { primaryEmail: uniqueEmail() });
    const fixture = await capturePass();
    const headers = inboxHeaders((await inboxMember(kit, user.id)).session);
    const spy = vi.spyOn(kit.mailer, 'send');
    try {
      expect((await send(fixture.id, headers)).status).toBe(200);
      await run(kit.env.DB, 'DELETE FROM user_emails WHERE email = ?', [user.primaryEmail]);
      expect(
        await first(kit.env.DB, 'SELECT email, state FROM sandbox_forwards WHERE capture_id = ?', [
          fixture.id,
        ]),
      ).toEqual({ email: null, state: 'sent' });
      expect((await send(fixture.id)).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
      expect((await detail(fixture.id)).forwarding).toBe('sent');
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('keeps the per-admin send limit before creating a reservation', async () => {
    const firstCapture = await capturePass();
    const secondCapture = await capturePass();
    const env: AppEnv = { ...kit.env, RL_REFRESH: fakeLimiter(1) as unknown as RateLimit };
    overrideDeps(env, { mailer: kit.mailer, registry: kit.registry, apns: kit.apns });
    const ctx = { ...jobCtxOf(kit), env };
    const spy = vi.spyOn(kit.mailer, 'send');
    try {
      const authority = await inboxAuthority(kit, adminSession);
      expect(await sendCapturedToMe(ctx, authority, firstCapture.id)).toEqual({ to: ADMIN_EMAIL });
      await expect(sendCapturedToMe(ctx, authority, secondCapture.id)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        await first(kit.env.DB, 'SELECT id FROM sandbox_forwards WHERE capture_id = ?', [
          secondCapture.id,
        ]),
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it.each(['pass', 'bundle'] as const)(
    'fences a stale %s snapshot at reservation',
    async (kind) => {
      // A pass's download token is content, not authority, and is not locked.
      const changes =
        kind === 'pass'
          ? (['transfer', 'quarantine'] as const)
          : (['transfer', 'quarantine', 'key-rotation'] as const);
      for (const change of changes) {
        const fixture = kind === 'pass' ? await capturePass() : await captureBundle();
        const member = fixture.passes.at(-1)!;
        const race = raceForward(async () => {
          if (change === 'transfer')
            await reassignHolder(
              jobCtxOf(kit),
              system,
              { passId: member.id, email: uniqueEmail() },
              null,
            );
          else if (change === 'quarantine')
            await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
              member.id,
            ]);
          else if (fixture.kind === 'bundle')
            await run(kit.env.DB, 'UPDATE bundles SET token = ? WHERE id = ?', [
              kit.ctx.ids.token(),
              fixture.bundle.id,
            ]);
          else
            await run(
              kit.env.DB,
              'UPDATE passes SET download_token = ?, link_generation = link_generation + 1 WHERE id = ?',
              [kit.ctx.ids.token(), member.id],
            );
        });
        const spy = vi.spyOn(kit.mailer, 'send');
        try {
          const authority = await inboxAuthority(kit, adminSession);
          await expect(sendCapturedToMe(race.ctx, authority, fixture.id)).rejects.toThrow();
          expect(race.intercepted()).toBe(true);
          expect(spy).not.toHaveBeenCalled();
          expect(
            await all(kit.env.DB, 'SELECT id FROM sandbox_forwards WHERE capture_id = ?', [
              fixture.id,
            ]),
          ).toEqual([]);
          expect((await api(`/test-inbox/${fixture.id}`, { headers: admin() })).status).toBe(200);
        } finally {
          spy.mockRestore();
        }
      }
    },
    60_000,
  );

  it.each(['pass', 'bundle'] as const)(
    'fences %s capability rotation at the final provider read',
    async (kind) => {
      const fixture = kind === 'pass' ? await capturePass() : await captureBundle();
      const member = fixture.passes[0]!;
      const race = raceForward(async () => {
        const mutation =
          fixture.kind === 'bundle'
            ? run(kit.env.DB, 'UPDATE bundles SET token = ? WHERE id = ?', [
                kit.ctx.ids.token(),
                fixture.bundle.id,
              ])
            : run(kit.env.DB, 'UPDATE passes SET download_token = ? WHERE id = ?', [
                kit.ctx.ids.token(),
                member.id,
              ]);
        // A bundle token is locked while a forward is in flight; a pass's download token is content.
        if (fixture.kind === 'bundle') await expect(mutation).rejects.toThrow();
        else await mutation;
      }, 'provider');
      const spy = vi.spyOn(kit.mailer, 'send');
      try {
        const authority = await inboxAuthority(kit, adminSession);
        expect(await sendCapturedToMe(race.ctx, authority, fixture.id)).toEqual({
          to: ADMIN_EMAIL,
        });
        expect(race.intercepted()).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(
          await all(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE capture_id = ?', [
            fixture.id,
          ]),
        ).toEqual([{ state: 'sent' }]);
        expect(
          await all(
            kit.env.DB,
            "SELECT actor_id, org_id FROM audit_log WHERE action = 'sandbox.send_to_me' AND target_id = ?",
            [fixture.id],
          ),
        ).toEqual([{ actor_id: actor.id, org_id: kit.org.id }]);
      } finally {
        spy.mockRestore();
      }
    },
    60_000,
  );

  it('does not reserve or send when the selected address is revoked after lookup', async () => {
    const user = await makeUser(kit.fx, { primaryEmail: uniqueEmail() });
    const fixture = await capturePass();
    const session = (await inboxMember(kit, user.id)).session;
    const authority = await inboxAuthority(kit, session);
    const race = raceForward(async () => {
      await run(kit.env.DB, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
        user.id,
        user.primaryEmail,
      ]);
    });
    const spy = vi.spyOn(kit.mailer, 'send');
    try {
      await expect(sendCapturedToMe(race.ctx, authority, fixture.id)).rejects.toThrow();
      expect(race.intercepted()).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(
        await all(kit.env.DB, 'SELECT id FROM sandbox_forwards WHERE capture_id = ?', [fixture.id]),
      ).toEqual([]);
      expect((await detail(fixture.id)).forwarding).toBe('none');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the selected verified address locked through the provider-boundary read', async () => {
    const user = await makeUser(kit.fx, { primaryEmail: uniqueEmail() });
    const session = (await inboxMember(kit, user.id)).session;
    const authority = await inboxAuthority(kit, session);
    const fixture = await capturePass();
    const race = raceForward(async () => {
      await expect(
        run(kit.env.DB, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
          user.id,
          user.primaryEmail,
        ]),
      ).rejects.toThrow();
    }, 'provider');
    const spy = vi.spyOn(kit.mailer, 'send');
    try {
      expect(await sendCapturedToMe(race.ctx, authority, fixture.id)).toEqual({
        to: user.primaryEmail,
      });
      expect(race.intercepted()).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(kit.mailer.sent.at(-1)?.to).toBe(user.primaryEmail);
      expect(
        await first(kit.env.DB, 'SELECT state, email FROM sandbox_forwards WHERE capture_id = ?', [
          fixture.id,
        ]),
      ).toEqual({ state: 'sent', email: user.primaryEmail });
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it.each(['pass', 'bundle'] as const)(
    'blocks transfer, quarantine and key rotation while a %s forward is in flight',
    async (kind) => {
      // A pass's download token is content, not authority, and is not locked.
      const changes =
        kind === 'pass'
          ? (['transfer', 'quarantine'] as const)
          : (['transfer', 'quarantine', 'key-rotation'] as const);
      for (const change of changes) {
        const fixture = kind === 'pass' ? await capturePass() : await captureBundle();
        const member = fixture.passes.at(-1)!;
        const prior = await first(
          kit.env.DB,
          'SELECT holder_email, download_token, link_generation, test_data_quarantined FROM passes WHERE id = ?',
          [member.id],
        );
        const provider = pauseProvider();
        const request = send(fixture.id);
        let response: Response | undefined;
        const mutate = () => {
          if (change === 'transfer')
            return reassignHolder(
              jobCtxOf(kit),
              system,
              { passId: member.id, email: uniqueEmail() },
              null,
            );
          if (change === 'quarantine')
            return run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
              member.id,
            ]);
          if (fixture.kind === 'bundle')
            return run(kit.env.DB, 'UPDATE bundles SET token = ? WHERE id = ?', [
              kit.ctx.ids.token(),
              fixture.bundle.id,
            ]);
          return run(kit.env.DB, 'UPDATE passes SET download_token = ? WHERE id = ?', [
            kit.ctx.ids.token(),
            member.id,
          ]);
        };
        try {
          await waitForProvider(provider.entered.promise, request);
          expect((await detail(fixture.id)).forwarding).toBe('sending');
          const reservation = await first<{ id: string; state: string }>(
            kit.env.DB,
            'SELECT id, state FROM sandbox_forwards WHERE capture_id = ?',
            [fixture.id],
          );
          expect(reservation?.state).toBe('sending');
          const protectedMembers = await all<{ pass_id: string }>(
            kit.env.DB,
            'SELECT pass_id FROM sandbox_forward_passes WHERE forward_id = ? ORDER BY pass_id',
            [reservation!.id],
          );
          expect(protectedMembers.map((row) => row.pass_id).sort()).toEqual(
            fixture.passes.map((pass) => pass.id).sort(),
          );
          await expect(mutate()).rejects.toThrow();
          expect(
            await first(
              kit.env.DB,
              'SELECT holder_email, download_token, link_generation, test_data_quarantined FROM passes WHERE id = ?',
              [member.id],
            ),
          ).toEqual(prior);
          expect(provider.spy).toHaveBeenCalledTimes(1);
        } finally {
          provider.release.resolve();
          try {
            response = await request;
          } finally {
            provider.spy.mockRestore();
          }
        }
        expect(response!.status).toBe(200);
        expect((await detail(fixture.id)).forwarding).toBe('sent');
        await mutate();
        expect((await api(`/test-inbox/${fixture.id}`, { headers: admin() })).status).toBe(200);
      }
    },
    120_000,
  );

  it('locks the bundle, membership, capture and verified actor at the provider boundary', async () => {
    const fixture = await captureBundle();
    const extra = await testPass(fixture.to);
    const member = fixture.passes[0]!;
    const provider = pauseProvider();
    const request = send(fixture.id);
    let response: Response | undefined;
    try {
      await waitForProvider(provider.entered.promise, request);
      const mutations = [
        () =>
          run(kit.env.DB, 'UPDATE bundles SET token = ? WHERE id = ?', [
            kit.ctx.ids.token(),
            fixture.bundle.id,
          ]),
        () =>
          run(
            kit.env.DB,
            'UPDATE bundle_passes SET position = position + 10 WHERE bundle_id = ? AND pass_id = ?',
            [fixture.bundle.id, member.id],
          ),
        () =>
          run(kit.env.DB, 'DELETE FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
            fixture.bundle.id,
            member.id,
          ]),
        () =>
          run(
            kit.env.DB,
            'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 9)',
            [fixture.bundle.id, extra.id],
          ),
        () =>
          run(kit.env.DB, 'UPDATE captured_emails SET html = ? WHERE id = ?', [
            'changed',
            fixture.id,
          ]),
        () =>
          run(kit.env.DB, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
            actor.id,
            ADMIN_EMAIL,
          ]),
      ];
      for (const mutate of mutations) await expect(mutate()).rejects.toThrow();
      // Suspending the org is a kill switch: an in-flight forward never holds it.
      await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
      expect((await detail(fixture.id)).forwarding).toBe('sending');
      expect(provider.spy).toHaveBeenCalledTimes(1);
    } finally {
      provider.release.resolve();
      try {
        response = await request;
      } finally {
        provider.spy.mockRestore();
      }
    }
    expect(response!.status).toBe(200);
    // The org was suspended and reactivated mid-flight: its owner can no longer settle the
    // reservation (the org epoch moved), so it stays `sending` until its lease expires.
    expect((await detail(fixture.id)).forwarding).toBe('sending');
  }, 60_000);

  it('keeps a preselected expired pass and its R2 objects while forwarding is in flight', async () => {
    const fixture = await capturePass();
    const pass = fixture.passes[0]!;
    const cutoff = kit.clock.now() - 86_400_000;
    await editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
      cutoff - 1,
      pass.id,
    ]);
    const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
    const selected = (await expiredTestPasses(kit.env.DB, cutoff, 25)).find(
      (row) => row.id === pass.id,
    );
    if (!selected) throw new Error('expired pass was not selected');
    expect(await kit.env.BUCKET.head(pass.objectKey)).not.toBeNull();
    const provider = pauseProvider();
    const request = send(fixture.id);
    let response: Response | undefined;
    try {
      await waitForProvider(provider.entered.promise, request);
      expect(
        await deletePassRows(
          kit.env.DB,
          selected,
          await prepareScanRetentionDelete(kit.env, selected),
          credentialKeysetCommitment,
          {
            testBefore: cutoff,
            lifecycleGeneration: selected.lifecycleGeneration,
          },
        ),
      ).toEqual({ deleted: false, objectKeys: [], deviceIds: [] });
      expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [pass.id])).toEqual({
        id: pass.id,
      });
      expect(
        await first(kit.env.DB, 'SELECT id FROM captured_emails WHERE id = ?', [fixture.id]),
      ).toEqual({ id: fixture.id });
      expect(await kit.env.BUCKET.head(pass.objectKey)).not.toBeNull();
      expect(provider.spy).toHaveBeenCalledTimes(1);
    } finally {
      provider.release.resolve();
      try {
        response = await request;
      } finally {
        provider.spy.mockRestore();
      }
    }
    expect(response!.status).toBe(200);
    const eligible = (await expiredTestPasses(kit.env.DB, cutoff, 25)).find(
      (row) => row.id === pass.id,
    );
    if (!eligible) throw new Error('acknowledged pass was not selected for retention');
    const retention = await prepareScanRetentionDelete(kit.env, eligible);
    const deleted = await deletePassRows(
      kit.env.DB,
      eligible,
      retention,
      credentialKeysetCommitment,
      {
        testBefore: cutoff,
        lifecycleGeneration: eligible.lifecycleGeneration,
      },
    );
    expect(deleted.deleted).toBe(true);
    expect(deleted.objectKeys).toContain(pass.objectKey);
    await deleteObjects(kit.env.BUCKET, deleted.objectKeys);
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [pass.id])).toBeNull();
    expect(await kit.env.BUCKET.head(pass.objectKey)).toBeNull();
  }, 60_000);

  it('makes only one provider call for concurrent duplicate requests and persists the in-flight state', async () => {
    const fixture = await captureBundle();
    const otherAdmin = await makeUser(kit.fx, { primaryEmail: uniqueEmail() });
    const otherHeaders = inboxHeaders((await inboxMember(kit, otherAdmin.id)).session);
    const provider = pauseProvider();
    const before = kit.mailer.sent.length;
    const request = send(fixture.id);
    let response: Response | undefined;
    try {
      await waitForProvider(provider.entered.promise, request);
      const freshApp = inboxApp(kit);
      const freshResponse = await freshApp.request(
        `${ORIGIN}/api/v1${scopedInboxPath(`/test-inbox/${fixture.id}`, kit.org.id)}`,
        { headers: admin() },
        kit.env,
      );
      expect(CapturedEmailDetailSchema.parse(await freshResponse.json()).forwarding).toBe(
        'sending',
      );
      await expectProblem(await send(fixture.id), [ADMIN_EMAIL, fixture.token]);
      await expectProblem(await send(fixture.id, otherHeaders), [
        otherAdmin.primaryEmail,
        fixture.token,
      ]);
      expect(provider.spy).toHaveBeenCalledTimes(1);
      expect(kit.mailer.sent).toHaveLength(before);
      expect(
        await all(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE capture_id = ?', [
          fixture.id,
        ]),
      ).toEqual([{ state: 'sending' }]);
    } finally {
      provider.release.resolve();
      try {
        response = await request;
      } finally {
        provider.spy.mockRestore();
      }
    }
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ to: ADMIN_EMAIL });
    expect(kit.mailer.sent).toHaveLength(before + 1);
    expect((await detail(fixture.id)).forwarding).toBe('sent');
    expect((await send(fixture.id)).status).toBe(200);
    expect(kit.mailer.sent).toHaveLength(before + 2);
    const listResponse = await api('/test-inbox?limit=200', { headers: admin() });
    const list = (await listResponse.json()) as { items: Record<string, unknown>[] };
    const item = list.items.find((entry) => entry.id === fixture.id);
    expect(item).toBeDefined();
    const serialized = JSON.stringify(item);
    for (const secret of [
      ADMIN_EMAIL,
      fixture.token,
      fixture.bundle.url,
      ...fixture.passes.map((pass) => pass.downloadToken),
    ])
      expect(serialized).not.toContain(secret);
  }, 60_000);

  it('persists an accepted-then-disconnected outcome as unknown and never resends it', async () => {
    const fixture = await capturePass();
    const original = kit.mailer.send.bind(kit.mailer);
    const spy = vi.spyOn(kit.mailer, 'send').mockImplementationOnce(async (message) => {
      await original(message);
      throw new Error('secret provider disconnect after acceptance');
    });
    const before = kit.mailer.sent.length;
    try {
      await expectProblem(await send(fixture.id), [ADMIN_EMAIL, 'secret provider disconnect']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(kit.mailer.sent).toHaveLength(before + 1);
      expect((await detail(fixture.id)).forwarding).toBe('unknown');
      expect(
        await first(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE capture_id = ?', [
          fixture.id,
        ]),
      ).toEqual({ state: 'unknown' });
      const freshApp = inboxApp(kit);
      const response = await freshApp.request(
        `${ORIGIN}/api/v1${scopedInboxPath(`/test-inbox/${fixture.id}`, kit.org.id)}`,
        { headers: admin() },
        kit.env,
      );
      expect(CapturedEmailDetailSchema.parse(await response.json()).forwarding).toBe('unknown');
      await expectProblem(await send(fixture.id), [ADMIN_EMAIL]);
      const pass = fixture.passes[0]!;
      await expect(
        reassignHolder(jobCtxOf(kit), system, { passId: pass.id, email: uniqueEmail() }, null),
      ).rejects.toThrow();
      await expect(
        run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]),
      ).rejects.toThrow();
      expect((await detail(fixture.id)).forwarding).toBe('unknown');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(kit.mailer.sent).toHaveLength(before + 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a sent-but-uncommitted attempt fenced after the acknowledgement write fails', async () => {
    const fixture = await capturePass();
    const before = kit.mailer.sent.length;
    const spy = vi.spyOn(kit.mailer, 'send');
    await run(
      kit.env.DB,
      `CREATE TRIGGER fail_forward_ack BEFORE UPDATE OF state ON sandbox_forwards
      WHEN NEW.state = 'sent' BEGIN SELECT RAISE(ABORT, 'forward acknowledgement unavailable'); END`,
    );
    try {
      await expectProblem(await send(fixture.id), [
        ADMIN_EMAIL,
        'forward acknowledgement unavailable',
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(kit.mailer.sent).toHaveLength(before + 1);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_forward_ack');
      spy.mockRestore();
    }
    expect((await detail(fixture.id)).forwarding).toBe('sending');
    expect(
      await first(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE capture_id = ?', [
        fixture.id,
      ]),
    ).toEqual({ state: 'sending' });
    await expectProblem(await send(fixture.id));
    expect(kit.mailer.sent).toHaveLength(before + 1);
  });

  it('does not resend on its own if the audit write fails; a new request may send again', async () => {
    const fixture = await capturePass();
    const before = kit.mailer.sent.length;
    const spy = vi.spyOn(kit.mailer, 'send');
    await run(
      kit.env.DB,
      `CREATE TRIGGER fail_forward_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'sandbox.send_to_me' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    );
    try {
      await expectProblem(await send(fixture.id), [ADMIN_EMAIL, 'audit unavailable']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await detail(fixture.id)).forwarding).toBe('sent');
      // The next explicit request is a new send; its audit write fails the same way.
      await expectProblem(await send(fixture.id));
      expect(spy).toHaveBeenCalledTimes(2);
      expect(kit.mailer.sent).toHaveLength(before + 2);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_forward_audit');
      spy.mockRestore();
    }
  });

  it('marks missing attachment as a definite failure and retries only on a new manual request', async () => {
    const fixture = await capturePass(true);
    const pass = fixture.passes[0]!;
    const object = await kit.env.BUCKET.get(pass.objectKey);
    if (!object) throw new Error('pass attachment missing');
    const bytes = await object.arrayBuffer();
    await kit.env.BUCKET.delete(pass.objectKey);
    const spy = vi.spyOn(kit.mailer, 'send');
    try {
      await expectProblem(await send(fixture.id), [ADMIN_EMAIL, pass.objectKey]);
      expect(spy).not.toHaveBeenCalled();
      expect((await detail(fixture.id)).forwarding).toBe('failed');
      expect(
        await first(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE capture_id = ?', [
          fixture.id,
        ]),
      ).toEqual({ state: 'failed' });
      await kit.env.BUCKET.put(pass.objectKey, bytes);
      expect((await detail(fixture.id)).forwarding).toBe('failed');
      expect(spy).not.toHaveBeenCalled();
      const response = await send(fixture.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ to: ADMIN_EMAIL });
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await detail(fixture.id)).forwarding).toBe('sent');
      expect((await send(fixture.id)).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      await kit.env.BUCKET.put(pass.objectKey, bytes);
    }
  }, 60_000);
});
