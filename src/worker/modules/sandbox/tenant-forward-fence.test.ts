import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  type UserRow,
} from '../../../../test/helpers/index.ts';
import { CapturedEmailListSchema } from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { overrideDeps } from '../passes/deps.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { resolveCaptureSnapshot } from './binding.ts';
import { getCapturedReference, type InboxAuthority } from './repo-capture.ts';
import {
  FORWARD_LEASE_MS,
  finishForward,
  readForwardContent,
  reserveForward,
} from './repo-forward.ts';
import {
  captureInboxPass,
  grantInboxMembership,
  type InboxMember,
  inboxApp,
  inboxAuthority,
  inboxHeaders,
  inboxMember,
  scopedInboxPath,
} from './test-tenant-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupKit();
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
  app = inboxApp(kit);
});

async function operator() {
  const user = await makeUser(kit.fx);
  return { user, ...(await inboxMember(kit, user.id, kit.org.id, 'pass_operator')) };
}

type Change = 'membership' | 'session';
async function revoke(change: Change, member: InboxMember & { user: UserRow }) {
  if (change === 'membership') {
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      member.membershipId,
    ]);
  } else {
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      await hashSessionCookie(member.session.cookieValue),
    ]);
  }
}

/** Change real D1 immediately before a selected prepared statement executes. */
function atStatement(matches: (sql: string) => boolean, intervene: () => Promise<void>) {
  let hits = 0;
  const sqls = new WeakMap<object, string>();
  const once = async () => {
    if (hits === 0) {
      hits++;
      await intervene();
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if ((property === 'first' || property === 'all') && matches(sql)) {
          return async (column?: string) => {
            await once();
            return property === 'all'
              ? target.all()
              : column === undefined
                ? target.first()
                : target.first(column);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    sqls.set(proxy, sql);
    return proxy;
  };
  const db = new Proxy(kit.env.DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      // A grant commits as one batch: intervene before it when any of its statements matches.
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((st) => matches(sqls.get(st) ?? ''))) await once();
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  overrideDeps(env, { mailer: kit.mailer, registry: kit.registry, apns: kit.apns });
  return { env, hits: () => hits };
}

function send(id: string, headers: Record<string, string>, env = kit.env) {
  return app.request(
    `${ORIGIN}/api/v1${scopedInboxPath(`/test-inbox/${id}/send-to-me`, kit.org.id)}`,
    { method: 'POST', headers },
    env,
  );
}

async function forwards(id: string) {
  return all<{ state: string }>(
    kit.env.DB,
    'SELECT state FROM sandbox_forwards WHERE capture_id = ? ORDER BY rowid',
    [id],
  );
}

async function audits(id: string) {
  return all(
    kit.env.DB,
    "SELECT id FROM audit_log WHERE action = 'sandbox.send_to_me' AND target_id = ?",
    [id],
  );
}

describe('Test inbox tenant authority at D1 boundaries', () => {
  it.each(['membership', 'session'] as const)(
    'does not reserve or call the provider when %s is revoked immediately before reservation',
    async (change) => {
      const actor = await operator();
      const capture = await captureInboxPass(kit);
      const race = atStatement(
        (sql) => /INSERT\s+INTO\s+sandbox_forwards\b/i.test(sql),
        () => revoke(change, actor),
      );
      const spy = vi.spyOn(kit.mailer, 'send');
      try {
        const response = await send(capture.id, inboxHeaders(actor.session), race.env);
        expect(response.status).toBe(404);
        expect(race.hits()).toBe(1);
        expect(await forwards(capture.id)).toEqual([]);
        expect(await audits(capture.id)).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
    60_000,
  );

  it('does not reserve after the operator grant is replaced with read-only membership', async () => {
    const actor = await operator();
    const capture = await captureInboxPass(kit);
    const race = atStatement(
      (sql) => /INSERT\s+INTO\s+sandbox_forwards\b/i.test(sql),
      async () => {
        await revoke('membership', actor);
        await grantInboxMembership(kit, actor.user.id, kit.org.id, 'read_only');
      },
    );
    const spy = vi.spyOn(kit.mailer, 'send');
    try {
      expect((await send(capture.id, inboxHeaders(actor.session), race.env)).status).toBe(404);
      expect(race.hits()).toBe(1);
      expect(await forwards(capture.id)).toEqual([]);
      expect(await audits(capture.id)).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      const detail = await app.request(
        `${ORIGIN}/api/v1${scopedInboxPath(`/test-inbox/${capture.id}`, kit.org.id)}`,
        { headers: inboxHeaders(actor.session) },
        kit.env,
      );
      expect(detail.status).toBe(200);
      expect((await send(capture.id, inboxHeaders(actor.session))).status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it.each(['membership', 'session'] as const)(
    'marks the reservation failed, without sending, if %s is revoked before the provider boundary',
    async (change) => {
      const actor = await operator();
      const capture = await captureInboxPass(kit);
      const race = atStatement(
        (sql) => /SELECT\s+c\.\*\s+FROM\s+captured_emails\s+c\s+JOIN\s+sandbox_forwards/i.test(sql),
        () => revoke(change, actor),
      );
      const spy = vi.spyOn(kit.mailer, 'send');
      try {
        const response = await send(capture.id, inboxHeaders(actor.session), race.env);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'TEST_FORWARD_PREPARATION_FAILED' });
        expect(race.hits()).toBe(1);
        // A revoked membership cannot settle its reservation: it stays locked until its lease
        // expires. A revoked session can (settling needs no session).
        if (change === 'membership') {
          expect(await forwards(capture.id)).toEqual([{ state: 'sending' }]);
          kit.clock.advance(FORWARD_LEASE_MS + 1);
        } else {
          expect(await forwards(capture.id)).toEqual([{ state: 'failed' }]);
        }
        expect(await audits(capture.id)).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
        if (change === 'membership')
          await grantInboxMembership(kit, actor.user.id, kit.org.id, 'pass_operator');
        const freshSession = await makeSession(kit.fx, { userId: actor.user.id });
        expect(spy).not.toHaveBeenCalled();
        const retry = await send(capture.id, inboxHeaders(freshSession));
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual({ to: actor.user.primaryEmail });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await forwards(capture.id)).toEqual([
          { state: change === 'membership' ? 'expired' : 'failed' },
          { state: 'sent' },
        ]);
        expect(await audits(capture.id)).toHaveLength(1);
        // A sent copy no longer blocks another explicit send.
        expect((await send(capture.id, inboxHeaders(freshSession))).status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    },
    60_000,
  );

  it.each(['membership', 'session'] as const)(
    'does not release detail, frame, or list content when %s is revoked at the final read',
    async (change) => {
      for (const kind of ['detail', 'html', 'list'] as const) {
        const actor = await operator();
        const orgId =
          kind === 'list' ? (await makeOrg(kit.fx, { name: 'List race tenant' })).id : kit.org.id;
        const membershipId =
          kind === 'list'
            ? await grantInboxMembership(kit, actor.user.id, orgId, 'pass_operator')
            : actor.membershipId;
        const capture = await captureInboxPass(kit, orgId);
        const race = atStatement(
          (sql) =>
            /FROM\s+captured_emails\s+c/i.test(sql) &&
            (kind === 'list' ? /AS\s+html/i.test(sql) : /SELECT\s+c\.\*/i.test(sql)) &&
            !/JOIN\s+sandbox_forwards/i.test(sql),
          () => revoke(change, { ...actor, membershipId }),
        );
        const path =
          kind === 'list'
            ? '/test-inbox?limit=1'
            : `/test-inbox/${capture.id}${kind === 'html' ? '/html' : ''}`;
        const response = await app.request(
          `${ORIGIN}/api/v1${scopedInboxPath(path, orgId)}`,
          { headers: inboxHeaders(actor.session) },
          race.env,
        );
        expect(race.hits(), kind).toBe(1);
        if (kind === 'list') {
          expect(response.status).toBe(200);
          expect(CapturedEmailListSchema.parse(await response.json()).items).toEqual([]);
        } else {
          expect(response.status).toBe(404);
          const body = await response.text();
          expect(body).not.toContain(capture.recipient);
          expect(body).not.toContain(capture.html);
          expect(body).not.toContain(capture.text);
        }
      }
    },
    120_000,
  );

  it.each(['membership', 'session'] as const)(
    'does not release already-read detail after %s revocation at forwarding-state lookup',
    async (change) => {
      const actor = await operator();
      const capture = await captureInboxPass(kit);
      const race = atStatement(
        (sql) =>
          /SELECT\s+COALESCE\s*\(\s*\(SELECT\s+f\.state\s+FROM\s+sandbox_forwards/i.test(sql),
        () => revoke(change, actor),
      );
      const response = await app.request(
        `${ORIGIN}/api/v1${scopedInboxPath(`/test-inbox/${capture.id}`, kit.org.id)}`,
        { headers: inboxHeaders(actor.session) },
        race.env,
      );
      expect(race.hits()).toBe(1);
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain(capture.recipient);
      expect(body).not.toContain(capture.html);
    },
    60_000,
  );

  it('cannot reserve or release content using even an active, then revoked, API key authority', async () => {
    const actor = await operator();
    const capture = await captureInboxPass(kit);
    const authority = await inboxAuthority(kit, actor.session);
    const ref = await getCapturedReference(kit.env.DB, capture.id, authority, kit.clock.now());
    if (!ref) throw new Error('Capture reference missing');
    const snapshot = await resolveCaptureSnapshot(kit.env.DB, ref);
    if (!snapshot) throw new Error('Capture snapshot missing');
    const key = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:read', 'passes:write'],
      mode: 'test',
    });
    // Model a hostile caller bypassing the session-only TypeScript boundary.
    const forged = { ...authority, kind: 'api_key', keyId: key.id } as unknown as InboxAuthority;
    expect(
      await reserveForward(
        kit.ctx,
        kit.fx.ids.id(),
        ref,
        snapshot,
        forged,
        actor.user.primaryEmail,
      ),
    ).toBe(false);
    expect(await forwards(capture.id)).toEqual([]);
    const id = kit.fx.ids.id();
    expect(
      await reserveForward(kit.ctx, id, ref, snapshot, authority, actor.user.primaryEmail),
    ).toBe(true);
    expect(
      await readForwardContent(
        kit.env.DB,
        id,
        ref,
        snapshot,
        forged,
        actor.user.primaryEmail,
        kit.clock.now(),
      ),
    ).toBeNull();
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      key.id,
    ]);
    expect(
      await readForwardContent(
        kit.env.DB,
        id,
        ref,
        snapshot,
        forged,
        actor.user.primaryEmail,
        kit.clock.now(),
      ),
    ).toBeNull();
    expect(
      await readForwardContent(
        kit.env.DB,
        id,
        ref,
        snapshot,
        authority,
        actor.user.primaryEmail,
        kit.clock.now(),
      ),
    ).not.toBeNull();
    await finishForward(kit.ctx, id, authority, 'failed', authority.userAccessRevision ?? 0);
    expect(
      await reserveForward(
        kit.ctx,
        kit.fx.ids.id(),
        ref,
        snapshot,
        forged,
        actor.user.primaryEmail,
      ),
    ).toBe(false);
    expect(await audits(capture.id)).toEqual([]);
    expect(
      await first(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE id = ?', [id]),
    ).toEqual({ state: 'failed' });
  }, 60_000);
});
