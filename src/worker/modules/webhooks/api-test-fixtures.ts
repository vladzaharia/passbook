import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { grantScanMembership } from '../scan/test-kit.ts';
import { type Rig, setupRig } from './deliver-test-fixtures.ts';

export interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
  json: any;
  text: string;
}

export interface Api {
  rig: Rig;
  /** Fresh limiters: ten test sends and one bulk replay a minute, as configured. */
  resetLimits(): void;
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Reply>;
  /** A session of a new user holding `roles` in the rig's org (or `orgId`), optionally in test mode. */
  member(
    roles: OrgRole[],
    options?: { orgId?: string; mode?: Mode },
  ): Promise<Record<string, string>>;
  /** A user with no membership anywhere. */
  outsider(): Promise<Record<string, string>>;
  key(options: {
    scopes: string[];
    orgId?: string | null;
    mode?: Mode;
  }): Promise<Record<string, string>>;
  otherOrg(): Promise<string>;
}

export async function setupApi(): Promise<Api> {
  const rig = await setupRig();
  const { env, clock, fx } = rig.kit;
  const api: Api = {
    rig,
    resetLimits() {
      Object.assign(env, {
        RL_WEBHOOK_OUT: fakeRateLimiter({ limit: 10 }),
        RL_WEBHOOK_REPLAY: fakeRateLimiter({ limit: 1 }),
      });
    },
    async call(method, path, body, headers = {}) {
      const app = createApp({
        stores: {
          ...denyAllStores,
          sessions: createSessionStore(env, clock),
          apiKeys: createApiKeyStore(env, clock),
        },
        clock,
      });
      const pending: Promise<unknown>[] = [];
      const executionCtx = {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext;
      const res = await app.request(
        `https://wallet.test${path}`,
        {
          method,
          headers: {
            ...headers,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
        executionCtx,
      );
      await Promise.all(pending);
      const text = await res.text();
      return { status: res.status, text, json: text ? JSON.parse(text) : {} };
    },
    async member(roles, options = {}) {
      const user = await makeUser(fx);
      await grantScanMembership(fx, options.orgId ?? rig.orgId, user.id, roles);
      const session = await makeSession(fx, { userId: user.id });
      return {
        ...session.headers,
        ...(options.mode === 'test' ? { 'x-passbook-mode': 'test' } : {}),
      };
    },
    async outsider() {
      const user = await makeUser(fx);
      return (await makeSession(fx, { userId: user.id })).headers;
    },
    async key({ scopes, orgId, mode }) {
      return (
        await makeApiKey(fx, {
          scopes,
          orgId: orgId === undefined ? rig.orgId : orgId,
          ...(mode ? { mode } : {}),
        })
      ).headers;
    },
    async otherOrg() {
      return (await makeOrg(fx)).id;
    },
  };
  api.resetLimits();
  return api;
}

export const BASE = '/api/v1/webhook-endpoints';
export const GOOD = {
  url: 'https://hooks.example.com/catch/abc123',
  eventTypes: ['pass.issued', 'pass.scanned'],
};

export const secretRows = (db: D1Database, endpointId: string) =>
  all<{ id: string; expires_at: number | null; ciphertext: unknown }>(
    db,
    'SELECT id, expires_at, ciphertext FROM webhook_endpoint_secrets WHERE endpoint_id = ? ORDER BY created_at, id',
    [endpointId],
  );

export const auditOf = (db: D1Database, action: string) =>
  all<{ org_id: string; actor_type: string; target_id: string; detail: string }>(
    db,
    'SELECT org_id, actor_type, target_id, detail FROM audit_log WHERE action = ? ORDER BY id',
    [action],
  );

export const rowCount = async (
  db: D1Database,
  table: string,
  where = '1 = 1',
  params: (string | number)[] = [],
) =>
  (await first<{ n: number }>(db, `SELECT count(*) AS n FROM ${table} WHERE ${where}`, params))
    ?.n ?? 0;

export const wipe = async (rig: Rig) => {
  await run(rig.db, 'DELETE FROM webhook_endpoints');
  await run(rig.db, "DELETE FROM audit_log WHERE action LIKE 'webhook.%'");
};
