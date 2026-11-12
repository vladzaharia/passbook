import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import { grant } from '../../platform/authority.ts';
import { first, run } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeConnection, type ConnectionAuthority } from './access.ts';
import { deleteConnection, getConnection, patchConnection } from './repo.ts';
import { connectionGrant, connectionIs } from './repo-grants.ts';
import { insertRun } from './repo-runs.ts';
import * as service from './service.ts';
import { addMembership, createDemo, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
let authority: ConnectionAuthority;
let membershipId: string;
let sessionHash: string;

beforeEach(async () => {
  kit = await makeKit();
  membershipId = await addMembership(kit, kit.actor.id, ['integration_admin']);
  const fixture = await makeSession(kit, { userId: kit.actor.id });
  const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
  if (!session) throw new Error('The persisted session did not resolve');
  sessionHash = session.sessionId;
  authority = await authorizeConnection(kit.sctx, session, kit.org.id, 'integrations:manage');
});

const generationOf = async (id: string) => (await getConnection(kit.env.DB, id))?.generation;

describe('connection generation is trigger-owned', () => {
  it('moves with config columns and never with health, cursor, schedule, name or limits', async () => {
    const dto = await createDemo(kit);
    expect(await generationOf(dto.id)).toBe(1);
    await run(
      kit.env.DB,
      `UPDATE connections SET health = 'degraded', consecutive_failures = 2, cursor = 'c', next_run_at = 5,
        last_run_at = 4, name = 'Renamed', interval_seconds = 60, max_concurrency = 2, updated_at = 9 WHERE id = ?`,
      [dto.id],
    );
    expect(await generationOf(dto.id)).toBe(1);
    await run(kit.env.DB, 'UPDATE connections SET config = \'{"count":9}\' WHERE id = ?', [dto.id]);
    expect(await generationOf(dto.id)).toBe(2);
    await run(kit.env.DB, 'UPDATE connections SET enabled = 0, auto_email = 1 WHERE id = ?', [
      dto.id,
    ]);
    expect(await generationOf(dto.id)).toBeGreaterThan(2);
  });

  it('refuses an app write that lowers the epoch', async () => {
    const dto = await createDemo(kit);
    await run(kit.env.DB, 'UPDATE connections SET config = \'{"count":8}\' WHERE id = ?', [dto.id]);
    await expect(
      run(kit.env.DB, 'UPDATE connections SET generation = 1 WHERE id = ?', [dto.id]),
    ).rejects.toThrow(/epoch_monotonic/);
  });
});

describe('connection grant safety', () => {
  it('refuses a write derived from a stale generation with STALE_GENERATION', async () => {
    const dto = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 5 } });
    const g = grant(kit.sctx, {
      purpose: 'org_mode.connection.update',
      principal: {
        kind: 'membership',
        membershipId,
        via: 'session',
        sessionIdHash: sessionHash,
        mode: 'live',
      },
      checks: [connectionIs({ id: dto.id, generation: 1 })],
      codes: { config: 'STALE_GENERATION' },
    });
    g.update('connections', { set: { cursor: 'x' }, where: { id: dto.id } });
    await expect(g.commit()).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBeNull();
  });

  it('refuses a patch against a stale generation without writing', async () => {
    const dto = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 5 } });
    expect(
      await patchConnection(
        kit.sctx,
        dto.id,
        { cursor: 'late' },
        { actor: { orgId: kit.org.id }, generation: 1 },
      ),
    ).toBe(0);
    expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBeNull();
  });

  it('refuses a run on a disabled connection but lets a configuration test run on it', async () => {
    const dto = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    const generation = (await generationOf(dto.id)) ?? 0;
    const start = (allowDisabled: boolean) =>
      insertRun(
        kit.sctx,
        {
          id: kit.ids.id(),
          connectionId: dto.id,
          trigger: 'test',
          startedAt: kit.clock.now(),
          expected: { orgId: kit.org.id, generation, allowDisabled },
        },
        { orgId: kit.org.id },
      );
    expect(await start(false)).toBe(false);
    expect(await start(true)).toBe(true);
  });

  it('violates the 0052 CHECK for a test-mode grant on a connection purpose', async () => {
    const dto = await createDemo(kit);
    const g = grant(kit.sctx, {
      purpose: 'org_mode.connection.update',
      principal: {
        kind: 'membership',
        membershipId,
        via: 'session',
        sessionIdHash: sessionHash,
        mode: 'test',
      },
    });
    g.update('connections', { set: { cursor: 'x' }, where: { id: dto.id } });
    await expect(g.commit()).rejects.toThrow(/constraint/i);
    expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBeNull();
    // The service refuses a test-mode request before any SQL.
    await expect(
      service.update(
        kit.sctx,
        kit.actor,
        dto.id,
        { enabled: false },
        { ...authority, mode: 'test' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('connection grant liveness', () => {
  it('keeps health, cursor and schedule writes working across name, interval and limit edits', async () => {
    const dto = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, {
      name: 'Renamed',
      intervalSeconds: 600,
      maxConcurrency: 3,
    });
    expect(await generationOf(dto.id)).toBe(1);
    const write = (patch: Parameters<typeof patchConnection>[2]) =>
      patchConnection(kit.sctx, dto.id, patch, {
        actor: { orgId: kit.org.id },
        generation: 1,
        enabled: true,
      });
    expect(await write({ health: 'healthy', lastRunAt: 5, lastSuccessAt: 5 })).toBe(1);
    expect(await write({ cursor: 'next' })).toBe(1);
    expect(await write({ nextRunAt: 99 })).toBe(1);
    expect(await getConnection(kit.env.DB, dto.id)).toMatchObject({
      health: 'healthy',
      cursor: 'next',
      nextRunAt: 99,
    });
  });

  it('resumes a perpetual job after suspend then reactivate, while a captured request grant stays refused', async () => {
    const dto = await createDemo(kit);
    const job = (cursor: string) =>
      patchConnection(
        kit.sctx,
        dto.id,
        { cursor },
        { actor: { orgId: kit.org.id }, generation: 1, enabled: true },
      );
    expect(await job('a')).toBe(1);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    expect(await job('b')).toBe(0);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    // The job checks status = 'active' at run time, not a captured epoch: it is not dead for good.
    expect(await job('c')).toBe(1);
    expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBe('c');
    // A request's captured access_revision moved with the suspension: it must re-authorize.
    await expect(
      service.update(kit.sctx, kit.actor, dto.id, { enabled: false }, authority),
    ).rejects.toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
  });
});

describe('deleting a connection', () => {
  it('counts the connection row only, although cascades remove its runs', async () => {
    const dto = await createDemo(kit);
    const runId = kit.ids.id();
    expect(
      await insertRun(
        kit.sctx,
        { id: runId, connectionId: dto.id, trigger: 'admin', startedAt: kit.clock.now() },
        { orgId: kit.org.id },
      ),
    ).toBe(true);
    expect(await deleteConnection(kit.sctx, dto.id, { orgId: kit.org.id }, 1)).toBe(true);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM connection_runs WHERE id = ?', [runId]),
    ).toBeNull();
    expect(await deleteConnection(kit.sctx, dto.id, { orgId: kit.org.id }, 1)).toBe(false);
  });
});

describe('webhook ingress grant', () => {
  it('is minted only from a verified-webhook token; a request context cannot obtain it', async () => {
    const { mintVerifiedWebhook, verifiedWebhookOf, webhookIngressGrant, withVerifiedWebhook } =
      await import('../../jobs/webhook-ingress.ts');
    const { createServiceContext } = await import('../../platform/service-context.ts');
    const request = createServiceContext(kit.env, { clock: kit.clock });
    // A plain request context carries no token and is no job context: every system grant is refused.
    expect(verifiedWebhookOf(request)).toBeUndefined();
    expect(() => connectionGrant(request, { orgId: kit.org.id }, 'webhook.stage')).toThrow(
      /jobGrant needs/,
    );
    // A forged token is refused by the factory.
    const forged = { orgId: kit.org.id, connectionId: 'x' } as never;
    expect(() => webhookIngressGrant(request, forged, {})).toThrow(/verified webhook/);
    // A minted token yields the fixed purpose, live, in its org, and only for that org.
    const verified = withVerifiedWebhook(
      request,
      mintVerifiedWebhook({ orgId: kit.org.id, id: 'c1' }),
    );
    const g = connectionGrant(verified, { orgId: kit.org.id }, 'webhook.stage');
    expect(g.purpose).toBe('org_mode.job.connection.webhook_ingress');
    expect(g.principal).toMatchObject({ kind: 'system', orgId: kit.org.id, mode: 'live' });
    expect(() => connectionGrant(verified, { orgId: 'other-org' }, 'webhook.stage')).toThrow(
      /jobGrant needs/,
    );
    // The grant writes only the staging tables.
    expect(() => g.update('connections', { set: { cursor: 'x' }, where: { id: 'c1' } })).toThrow();
  });
});
