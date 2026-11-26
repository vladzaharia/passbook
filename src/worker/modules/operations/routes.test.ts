import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import {
  keyHeaders,
  ORG_KIND,
  PLATFORM_KIND,
  person,
  registerTestKinds,
  STARTER_KIND,
} from './operations-test-fixtures.ts';
import { progressOf } from './progress.ts';
import { startOperation } from './start.ts';

const ORIGIN = 'https://wallet.test';
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

const call = (path: string, headers: Record<string, string>, method = 'GET', body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1/operations${path}`,
    {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    kit.env,
  );

const orgOp = (orgId = kit.org.id, mode: 'live' | 'test' = 'live') =>
  startOperation(kit.ctx, {
    kind: ORG_KIND.kind,
    org: { orgId, mode },
    actor: { type: 'user', id: 'someone' },
    subject: { k: kit.ctx.ids.id() },
  });

describe('operations read rules', () => {
  it('reads an org operation as a member with the capability, with an ETag and a 304', async () => {
    const op = await orgOp();
    const res = await call(`/${op.id}`, auth.admin());
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBe(`"${op.id}:${op.revision}"`);
    expect(((await res.json()) as OperationDto).id).toBe(op.id);
    const again = await call(`/${op.id}`, { ...auth.admin(), 'if-none-match': etag as string });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    await progressOf(kit.ctx, op.id, 1).step('a').done();
    const moved = await call(`/${op.id}`, { ...auth.admin(), 'if-none-match': etag as string });
    expect(moved.status).toBe(200);
  });

  it('reads with a key holding a scope that reaches the kind, and 404s one that does not', async () => {
    const op = await orgOp();
    expect((await call(`/${op.id}`, await keyHeaders(kit, ['passes:read']))).status).toBe(200);
    expect((await call(`/${op.id}`, await keyHeaders(kit, ['templates:read']))).status).toBe(404);
  });

  it('gives everyone else 404: no membership, no capability, the other mode, unknown ids', async () => {
    const op = await orgOp();
    const outsider = await person(kit);
    expect((await call(`/${op.id}`, outsider.headers)).status).toBe(404);
    expect((await call('/no-such-operation', auth.admin())).status).toBe(404);
    // A Test-mode request does not read a Live operation.
    expect((await call(`/${op.id}`, auth.admin({ mode: 'test' }))).status).toBe(404);
    const body = await (await call(`/${op.id}`, outsider.headers)).json();
    expect(body).toMatchObject({ code: 'OPERATION_NOT_FOUND' });
  });

  it('loses read at once when the membership is revoked', async () => {
    const op = await orgOp();
    const member = await person(kit, ['read_only']);
    expect((await call(`/${op.id}`, member.headers)).status).toBe(200);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE user_id = ?', [
      kit.clock.now(),
      member.userId,
    ]);
    expect((await call(`/${op.id}`, member.headers)).status).toBe(404);
  });

  it('reads a starter operation only as the starting session', async () => {
    const owner = await person(kit);
    const op = await startOperation(kit.ctx, {
      kind: STARTER_KIND.kind,
      session: 'sess',
      actor: { type: 'user', id: owner.userId },
    });
    expect((await call(`/${op.id}`, owner.headers)).status).toBe(200);
    expect((await call(`/${op.id}`, (await person(kit)).headers)).status).toBe(404);
    // Not an admin, not an org admin, not a key.
    expect((await call(`/${op.id}`, auth.admin())).status).toBe(404);
    expect((await call(`/${op.id}`, await keyHeaders(kit, ['passes:read']))).status).toBe(404);
  });

  it('reads a platform operation as a platform admin only', async () => {
    const op = await startOperation(kit.ctx, {
      kind: PLATFORM_KIND.kind,
      actor: { type: 'system', id: null },
    });
    expect((await call(`/${op.id}`, auth.admin())).status).toBe(200);
    expect((await call(`/${op.id}`, auth.user())).status).toBe(404);
    expect((await call(`/${op.id}`, await keyHeaders(kit, ['passes:read']))).status).toBe(404);
  });
});

describe('operations tenant isolation', () => {
  it('never shows another org operation, by id or in a list', async () => {
    const other = await makeOrg(kit.fx, { name: 'Other tenant' });
    const theirs = await orgOp(other.id);
    const mine = await orgOp();
    expect((await call(`/${theirs.id}`, auth.admin())).status).toBe(404);
    expect((await call(`/${theirs.id}`, await keyHeaders(kit, ['passes:read']))).status).toBe(404);
    const list = (await (
      await call(`?orgId=${kit.org.id}&kind=test.org`, auth.admin())
    ).json()) as {
      items: OperationDto[];
    };
    expect(list.items.map((o) => o.id)).toEqual([mine.id]);
    // Naming the other org's id gains nothing.
    const named = (await (await call(`?orgId=${other.id}&kind=test.org`, auth.admin())).json()) as {
      items: OperationDto[];
    };
    expect(named.items).toEqual([]);
    // A key bound to one org cannot name another.
    const keyed = (await (
      await call(`?orgId=${other.id}`, await keyHeaders(kit, ['passes:read']))
    ).json()) as { items: OperationDto[] };
    expect(keyed.items).toEqual([]);
  });

  it('keeps Test and Live apart in a list', async () => {
    await orgOp(kit.org.id, 'test');
    const live = await orgOp(kit.org.id, 'live');
    const items = (
      (await (await call(`?orgId=${kit.org.id}&kind=test.org`, auth.admin())).json()) as {
        items: OperationDto[];
      }
    ).items;
    expect(items.map((o) => o.id)).toEqual([live.id]);
  });
});

describe('operations list', () => {
  it('lists active and mine, newest first, and pages with a cursor', async () => {
    const owner = await person(kit);
    const mk = async (n: number) => {
      kit.clock.advance(10);
      return startOperation(kit.ctx, {
        kind: STARTER_KIND.kind,
        session: 'sess',
        actor: { type: 'user', id: owner.userId },
        subject: { n: String(n) },
      });
    };
    const ops = [await mk(1), await mk(2), await mk(3)];
    await progressOf(kit.ctx, ops[0]?.id, 1).succeed();
    const active = (await (await call('?active=true&mine=true', owner.headers)).json()) as {
      items: OperationDto[];
    };
    expect(active.items.map((o) => o.id)).toEqual([ops[2]?.id, ops[1]?.id]);
    const page1 = (await (await call('?limit=2', owner.headers)).json()) as {
      items: OperationDto[];
      nextCursor: string;
    };
    expect(page1.items.map((o) => o.id)).toEqual([ops[2]?.id, ops[1]?.id]);
    const page2 = (await (
      await call(`?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, owner.headers)
    ).json()) as { items: OperationDto[]; nextCursor: string | null };
    expect(page2.items.map((o) => o.id)).toEqual([ops[0]?.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('filters by target and kind, and rejects a bad cursor', async () => {
    const owner = await person(kit);
    await startOperation(kit.ctx, {
      kind: STARTER_KIND.kind,
      session: 'sess',
      actor: { type: 'user', id: owner.userId },
      target: { type: 'sandbox', id: 's1' },
    });
    const hit = (await (await call('?target=sandbox:s1', owner.headers)).json()) as {
      items: OperationDto[];
    };
    expect(hit.items).toHaveLength(1);
    const miss = (await (await call('?target=sandbox:s2', owner.headers)).json()) as {
      items: OperationDto[];
    };
    expect(miss.items).toHaveLength(0);
    expect((await call('?cursor=garbage', owner.headers)).status).toBe(422);
  });
});

describe('operations route auth', () => {
  it('asks for a credential', async () => {
    expect((await call('/x', {})).status).toBe(401);
    expect((await call('', {})).status).toBe(401);
    expect((await call('/x/cancel', {}, 'POST')).status).toBe(401);
    expect((await call('/x/retry', {}, 'POST')).status).toBe(401);
  });

  it('refuses a key with no scope any kind uses', async () => {
    const op = await orgOp();
    const headers = await keyHeaders(kit, ['scans:write']);
    expect((await call(`/${op.id}`, headers)).status).toBe(403);
    expect((await call(`/${op.id}/cancel`, headers, 'POST')).status).toBe(403);
  });

  it('refuses a read-only key a stop and a retry', async () => {
    const op = await orgOp();
    const headers = await keyHeaders(kit, ['passes:read']);
    expect((await call(`/${op.id}/cancel`, headers, 'POST')).status).toBe(403);
    expect((await call(`/${op.id}/retry`, headers, 'POST')).status).toBe(403);
  });
});
