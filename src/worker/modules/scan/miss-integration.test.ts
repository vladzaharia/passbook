import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import {
  actorFor,
  audits,
  counter,
  kit,
  scopedKey,
  setupMissIntegration,
  templateId,
  WINDOW_MS,
  windowStart,
} from './miss-integration-test-fixtures.ts';
import { grantReadMiss } from './misses.ts';
import { countMiss } from './misses-test-fixtures.ts';
import { missCounterKey } from './repo-miss-authority.ts';
import { grantScanMembership, key } from './test-kit.ts';

beforeAll(setupMissIntegration);

describe('scoped atomic miss accounting', () => {
  it('uses an unambiguous tenant, mode, actor tuple without credential input', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const actor = await actorFor(scanner.id);
    expect(missCounterKey(actor)).toBe(scopedKey(actor.orgId, actor.mode, actor.actorKey));
    const punctuated = { ...actor, orgId: 'tenant,"one"', actorKey: 'u:one,\\two' };
    expect(missCounterKey(punctuated)).toBe(
      `scan:miss:${JSON.stringify([punctuated.orgId, punctuated.mode, punctuated.actorKey])}`,
    );
    expect(missCounterKey({ ...punctuated, orgId: 'tenant' })).not.toBe(missCounterKey(punctuated));
    expect(missCounterKey({ ...punctuated, mode: 'test' })).not.toBe(missCounterKey(punctuated));
  });

  it.each(['revoked scanner', 'archived event', 'removed scope', 'paused session'] as const)(
    'rechecks %s before a read-only increment',
    async (change) => {
      const event =
        change === 'archived event' ? await kit.event({ templateIds: [templateId] }) : null;
      const scanner = await kit.scanner(
        event ? { eventId: event.id } : { templateIds: [templateId] },
      );
      let sessionId: string | null = null;
      if (change === 'paused session') {
        sessionId = kit.fx.ids.id();
        await run(
          kit.env.DB,
          `INSERT INTO scanning_sessions
          (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
          SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at FROM scanners WHERE id=?`,
          [sessionId, JSON.stringify({ templateIds: [templateId] }), scanner.id],
        );
        await run(
          kit.env.DB,
          `INSERT INTO scanning_devices
          (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
          SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
          [sessionId, scanner.id],
        );
      }
      const actor = await actorFor(scanner.id);
      const counterKey = missCounterKey(actor);
      await countMiss(kit.ctx, actor);
      expect(await counter(counterKey)).toEqual({ count: 1 });
      await run(kit.env.DB, 'UPDATE counters SET count=30 WHERE key=? AND window_start=?', [
        counterKey,
        windowStart(),
      ]);
      if (change === 'revoked scanner')
        await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          scanner.id,
        ]);
      else if (change === 'archived event')
        await run(kit.env.DB, 'UPDATE scan_events SET archived_at=? WHERE id=?', [
          kit.clock.now(),
          event!.id,
        ]);
      else if (change === 'removed scope')
        await run(
          kit.env.DB,
          'DELETE FROM scanner_templates WHERE scanner_id=? AND template_id=?',
          [scanner.id, templateId],
        );
      else
        await run(
          kit.env.DB,
          "UPDATE scanning_sessions SET status='paused',updated_at=updated_at+1 WHERE id=?",
          [sessionId],
        );
      await countMiss(kit.ctx, actor);
      expect(await counter(counterKey)).toEqual({ count: 30 });
      expect(await audits(scanner.id)).toHaveLength(0);
    },
  );

  it.each(['session', 'membership'] as const)(
    'rechecks a user-backed %s before a read-only increment',
    async (change) => {
      const user = await makeUser(kit.fx);
      const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
      const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
      const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
      if (!auth) throw new Error('Missing admin session');
      const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
      if (authority.kind !== 'session') throw new Error('Expected session authority');
      const actor = adminActor(auth, 'live', {
        orgId: kit.org.id,
        event: null,
        templateIds: [],
        timeZone: 'UTC',
      });
      actor.platformSessionId = auth.sessionId;
      actor.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
      actor.role = tenantScanRole(authority);
      const counterKey = missCounterKey(actor);
      await countMiss(kit.ctx, actor);
      expect(await counter(counterKey)).toEqual({ count: 1 });
      await run(kit.env.DB, 'UPDATE counters SET count=30 WHERE key=? AND window_start=?', [
        counterKey,
        windowStart(),
      ]);
      if (change === 'session')
        await run(kit.env.DB, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
          kit.clock.now(),
          auth.sessionId,
        ]);
      else
        await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          membershipId,
        ]);
      await countMiss(kit.ctx, actor);
      expect(await counter(counterKey)).toEqual({ count: 30 });
      expect(await audits(user.id)).toHaveLength(0);
    },
  );

  it('atomically counts and audits read-only misses at the cap and resets by window', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const actor = await actorFor(scanner.id);
    const counterKey = missCounterKey(actor);
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,29)', [
      counterKey,
      windowStart(),
    ]);
    await countMiss(kit.ctx, actor);
    await expect(countMiss(kit.ctx, actor)).rejects.toMatchObject({
      code: 'SCAN_TOO_MANY_MISSES',
      status: 429,
    });
    await expect(countMiss(kit.ctx, actor)).rejects.toMatchObject({
      code: 'SCAN_TOO_MANY_MISSES',
      status: 429,
    });
    expect(await counter(counterKey)).toEqual({ count: 32 });
    expect(await audits(scanner.id)).toHaveLength(1);
    kit.clock.advance(WINDOW_MS);
    await countMiss(kit.ctx, actor);
    expect(await counter(counterKey)).toEqual({ count: 1 });
    expect(await audits(scanner.id)).toHaveLength(1);
  });

  it('does not count, and discloses nothing, when the scanner credential rotates before the count', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const actor = await actorFor(scanner.id);
    const counterKey = missCounterKey(actor);
    // A CSRF rotation moves the credential epoch the scanner principal binds.
    await run(kit.env.DB, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
      kit.fx.ids.token(),
      scanner.id,
    ]);
    await countMiss(kit.ctx, actor);
    expect(await counter(counterKey)).toBeNull();
    expect(await audits(scanner.id)).toHaveLength(0);
  });

  it('counts only while no pass matches the input, and a pass of another tenant never matters', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const actor = await actorFor(scanner.id);
    const counterKey = missCounterKey(actor);
    await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const code = `LATE-${key()}`;
    const credentials = await credentialTombstoneRefsForInput(
      kit.ctx,
      kit.org.id,
      'live',
      { code, method: 'camera' },
      false,
      'require',
    );
    const unchanged = {
      sql: 'NOT EXISTS (SELECT 1 FROM passes p WHERE p.org_id = {org} AND p.mode = {mode} AND p.external_id = ?)',
      params: [code],
    };
    const refs = credentials.credentialTombstoneRefs;
    expect(await grantReadMiss(kit.ctx, actor, { refs, unchanged })).toBe('counted');
    expect(await counter(counterKey)).toEqual({ count: 1 });
    // The same input in the other mode is not this tenant's match.
    const other = await kit.scanPass(templateId, {}, { mode: 'test' });
    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [code, other.id]);
    expect(await grantReadMiss(kit.ctx, actor, { refs, unchanged })).toBe('counted');
    expect(await counter(counterKey)).toEqual({ count: 2 });
    // A matching pass appearing in the actor's own org and mode makes the miss stale.
    const pass = await kit.scanPass(templateId);
    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [code, pass.id]);
    expect(await grantReadMiss(kit.ctx, actor, { refs, unchanged })).toBe('not_committed');
    expect(await counter(counterKey)).toEqual({ count: 2 });
    expect(await audits(scanner.id)).toHaveLength(0);
  });

  it('serializes concurrent misses crossing the cap into one audit', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const actor = await actorFor(scanner.id);
    const counterKey = missCounterKey(actor);
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,29)', [
      counterKey,
      windowStart(),
    ]);
    const outcomes = await Promise.allSettled([
      countMiss(kit.ctx, actor),
      countMiss(kit.ctx, actor),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject([
      { reason: { code: 'SCAN_TOO_MANY_MISSES', status: 429 } },
    ]);
    expect(await counter(counterKey)).toEqual({ count: 31 });
    expect(await audits(scanner.id)).toHaveLength(1);
  });

  it.each(['counter', 'audit'] as const)(
    'rolls back a read-only miss if its %s write fails',
    async (failure) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const actor = await actorFor(scanner.id);
      const counterKey = missCounterKey(actor);
      const before = failure === 'audit' ? 30 : 29;
      await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,?)', [
        counterKey,
        windowStart(),
        before,
      ]);
      const trigger = `miss_read_fail_${failure}`;
      const ddl =
        failure === 'audit'
          ? `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_log
          WHEN NEW.action='scan.misses_capped' BEGIN SELECT RAISE(ABORT, 'miss audit failed'); END`
          : `CREATE TRIGGER ${trigger} BEFORE UPDATE ON counters
          WHEN NEW.key LIKE 'scan:miss:%' BEGIN SELECT RAISE(ABORT, 'miss counter failed'); END`;
      await run(kit.env.DB, ddl);
      try {
        await expect(countMiss(kit.ctx, actor)).rejects.toThrow(/miss (audit|counter) failed/);
        expect(await counter(counterKey)).toEqual({ count: before });
        expect(await audits(scanner.id)).toHaveLength(0);
      } finally {
        await run(kit.env.DB, `DROP TRIGGER IF EXISTS ${trigger}`);
      }
      if (failure === 'audit')
        await expect(countMiss(kit.ctx, actor)).rejects.toMatchObject({
          code: 'SCAN_TOO_MANY_MISSES',
        });
      else await countMiss(kit.ctx, actor);
      expect(await counter(counterKey)).toEqual({ count: before + 1 });
      expect(await audits(scanner.id)).toHaveLength(failure === 'audit' ? 1 : 0);
    },
  );
});
