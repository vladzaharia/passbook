// Platform-keys §3.6 test 9: a Platform key reads the operations it started, and nothing else.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import {
  ORG_KIND,
  PLATFORM_KIND,
  person,
  registerTestKinds,
  STARTER_KIND,
} from './operations-test-fixtures.ts';
import { startOperation } from './start.ts';

let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let undo: () => void;

beforeEach(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  undo = registerTestKinds();
});
afterEach(() => undo());

const call = (path: string, headers: Record<string, string>, method = 'GET') =>
  app.request(`https://wallet.test/api/v1/operations${path}`, { method, headers }, kit.env);

async function platformKey(scopes: string[] = ['platform:users']) {
  const key = await makeApiKey(kit.fx, {
    orgId: null,
    kind: 'platform',
    scopes,
    expiresAt: kit.clock.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
  });
  return { id: key.id, headers: { ...key.headers, 'cf-connecting-ip': '198.51.100.7' } };
}

const startedBy = (actor: { type: 'user' | 'api_key'; id: string }, kind = PLATFORM_KIND.kind) =>
  startOperation(kit.ctx, { kind, actor, subject: { s: kit.ctx.ids.id() } });

describe('a Platform key and operations', () => {
  it('reads and lists the operations it started', async () => {
    const key = await platformKey();
    const mine = await startedBy({ type: 'api_key', id: key.id });
    const read = await call(`/${mine.id}`, key.headers);
    expect(read.status).toBe(200);
    expect(((await read.json()) as OperationDto).id).toBe(mine.id);
    const listed = await call('', key.headers);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: OperationDto[] }).items.map((o) => o.id)).toEqual([
      mine.id,
    ]);
  });

  it("answers 404 for another key's, a session's and an org's operation, and lists none of them", async () => {
    const key = await platformKey();
    const other = await platformKey(['platform:read']);
    const theirs = await startedBy({ type: 'api_key', id: other.id });
    const session = await startedBy({ type: 'user', id: 'someone' });
    const org = await startOperation(kit.ctx, {
      kind: ORG_KIND.kind,
      org: { orgId: kit.org.id, mode: 'live' },
      actor: { type: 'api_key', id: key.id },
      subject: { k: kit.ctx.ids.id() },
    });
    const starter = await startOperation(kit.ctx, {
      kind: STARTER_KIND.kind,
      session: 'sess',
      actor: { type: 'user', id: 'someone' },
      subject: { s: kit.ctx.ids.id() },
    });
    for (const op of [theirs, session, org, starter])
      expect((await call(`/${op.id}`, key.headers)).status, op.id).toBe(404);
    const listed = (await (await call('?mine=true', key.headers)).json()) as {
      items: OperationDto[];
    };
    expect(listed.items).toEqual([]);
  });

  it('is not reached by an org key, and a platform admin still reads platform operations', async () => {
    const key = await platformKey();
    const mine = await startedBy({ type: 'api_key', id: key.id });
    // An org key never sees a platform operation, even one its own id started.
    const orgKey = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
    expect((await call(`/${mine.id}`, orgKey.headers)).status).toBe(404);
    const admin = await person(kit, ['org_admin'], ['admin', 'user']);
    expect((await call(`/${mine.id}`, admin.headers)).status).toBe(200);
    // Naming another org changes nothing: a Platform key lists only what it started.
    const stranger = await makeOrg(kit.fx);
    const listed = (await (await call(`?orgId=${stranger.id}`, key.headers)).json()) as {
      items: OperationDto[];
    };
    expect(listed.items.map((o) => o.id)).toEqual([mine.id]);
  });

  it('cannot stop or retry, whatever it holds', async () => {
    const key = await platformKey(['platform:read', 'platform:users']);
    const mine = await startedBy({ type: 'api_key', id: key.id });
    for (const action of ['cancel', 'retry'])
      expect((await call(`/${mine.id}/${action}`, key.headers, 'POST')).status, action).toBe(403);
  });
});
