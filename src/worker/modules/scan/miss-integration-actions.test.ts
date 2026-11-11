import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import {
  app,
  atStopCommit,
  audits,
  body,
  counter,
  kit,
  scopedKey,
  setupMissIntegration,
  templateId,
  WINDOW_MS,
  windowStart,
} from './miss-integration-test-fixtures.ts';
import { grantScanMembership, key, ORIGIN, startScanCredentialTransfer } from './test-kit.ts';

beforeAll(async () => {
  await setupMissIntegration();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});


const STATUS = { SCANNER_REPAIR: 401, ACTOR_CHANGED: 403 } as const;
type MissRefusal =
  | 'SCANNER_REPAIR'
  | 'ACTOR_CHANGED'
  | 'SCAN_CONFIG_CHANGED'
  | 'SCAN_PASS_CHANGED'
  | 'SCAN_IN_PROGRESS';

/** A stop that loses its grant is a classified refusal; nothing is counted and the claim is released. */
async function expectNotCounted(
  response: Response,
  code: MissRefusal,
  scanId: string,
  counterKey: string,
  actorId: string,
) {
  const status = STATUS[code as keyof typeof STATUS] ?? 409;
  const text = await response.text();
  expect(`${response.status} ${(JSON.parse(text) as { code?: string }).code}`).toBe(
    `${status} ${code}`,
  );
  expect(await counter(counterKey)).toEqual({ count: 30 });
  expect(await audits(actorId)).toHaveLength(0);
  const claim = await first<{ state: string; outcome: string | null }>(
    kit.env.DB,
    'SELECT state,outcome FROM scans WHERE id=?',
    [scanId],
  );
  expect(claim === null || (claim.state === 'failed' && claim.outcome === null)).toBe(true);
}

describe('scoped atomic miss accounting', () => {
  it('does not return a successful resolve after an ignored cap audit', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const counterKey = scopedKey(kit.org.id, 'live', `s:${scanner.id}`);
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
      counterKey,
      windowStart(),
    ]);
    await run(
      kit.env.DB,
      `CREATE TRIGGER miss_resolve_audit_ignore BEFORE INSERT ON audit_log
      WHEN NEW.action='scan.misses_capped' BEGIN SELECT RAISE(IGNORE); END`,
    );
    let response: Response;
    try {
      response = await kit.post(scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input: { code: 'MISS-READ-ROLLBACK', method: 'camera' },
        clientTs: kit.clock.now(),
      });
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER IF EXISTS miss_resolve_audit_ignore');
    }
    expect(response.status).toBe(500);
    expect(await counter(counterKey)).toEqual({ count: 30 });
    expect(await audits(scanner.id)).toHaveLength(0);
  });

  it('shares one counter across resolve, lookup and completed action misses', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const counterKey = scopedKey(kit.org.id, 'live', `s:${scanner.id}`);
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,28)', [
      counterKey,
      windowStart(),
    ]);
    const resolved = await kit.post(scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: { code: 'MISS-RESOLVE', method: 'camera' },
      clientTs: kit.clock.now(),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ kind: 'refused', reason: 'not_found' });
    expect((await kit.post(scanner.headers, '/lookup', { q: 'missinglookupvalue' })).status).toBe(
      200,
    );
    expect(await counter(counterKey)).toEqual({ count: 30 });
    const capped = await kit.post(scanner.headers, '/actions', body(key(), 'MISS-ACTION'));
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ code: 'SCAN_TOO_MANY_MISSES' });
    expect(await counter(counterKey)).toEqual({ count: 31 });
    expect(await audits(scanner.id)).toHaveLength(1);
  });

  it('separates a user across tenants and modes', async () => {
    const user = await makeUser(kit.fx);
    const other = await makeOrg(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    await grantScanMembership(kit.fx, other.id, user.id, ['pass_operator']);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    const actorKey = `u:${user.id}`;
    const live = scopedKey(kit.org.id, 'live', actorKey);
    const test = scopedKey(kit.org.id, 'test', actorKey);
    const otherLive = scopedKey(other.id, 'live', actorKey);
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
      live,
      windowStart(),
    ]);
    const request = (orgId: string, mode: 'live' | 'test', code: string) =>
      app.request(
        `${ORIGIN}/api/v1/scan/actions`,
        {
          method: 'POST',
          headers: {
            ...session.headers,
            origin: ORIGIN,
            'content-type': 'application/json',
            'x-passbook-mode': mode,
          },
          body: JSON.stringify({ ...body(key(), code), scope: { orgId, timeZone: 'UTC' } }),
        },
        kit.env,
      );
    expect((await request(other.id, 'live', 'ORG-OTHER')).status).toBe(200);
    expect((await request(kit.org.id, 'test', 'MODE-TEST')).status).toBe(200);
    expect((await request(kit.org.id, 'live', 'MODE-LIVE')).status).toBe(429);
    expect(await counter(otherLive)).toEqual({ count: 1 });
    expect(await counter(test)).toEqual({ count: 1 });
    expect(await counter(live)).toEqual({ count: 31 });
    expect(await audits(user.id)).toMatchObject([
      { org_id: kit.org.id, actor_type: 'user', actor_id: user.id },
    ]);
  });

  it('commits an event proof, counter and cap audit once, including on replay', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const counterKey = scopedKey(kit.org.id, 'live', `s:${scanner.id}`);
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
      counterKey,
      windowStart(),
    ]);
    const secret = `NO-SUCH-CREDENTIAL-${key()}`;
    const request = body(key(), secret);
    const capped = await kit.post(scanner.headers, '/actions', request);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ code: 'SCAN_TOO_MANY_MISSES' });
    const scan = await first<{ id: string; state: string; reason: string }>(
      kit.env.DB,
      'SELECT id,state,reason FROM scans WHERE idempotency_key=?',
      [request.idempotencyKey],
    );
    expect(scan).toMatchObject({ state: 'done', reason: 'not_found' });
    expect(await counter(counterKey)).toEqual({ count: 31 });
    const recorded = await first<{ event_id: string; reason: string }>(
      kit.env.DB,
      'SELECT event_id, reason FROM scans WHERE id=?',
      [scan?.id],
    );
    expect(recorded).toEqual({ event_id: event.id, reason: 'not_found' });
    expect(JSON.stringify(await audits(scanner.id))).not.toContain(secret);
    expect(counterKey).not.toContain(secret);
    const replay = await kit.post(scanner.headers, '/actions', request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      reason: 'not_found',
      replay: true,
      scanId: scan?.id,
    });
    expect(await counter(counterKey)).toEqual({ count: 31 });
    expect(await audits(scanner.id)).toHaveLength(1);
    const previousWindow = windowStart();
    kit.clock.advance(WINDOW_MS);
    const laterReplay = await kit.post(scanner.headers, '/actions', request);
    expect(laterReplay.status).toBe(200);
    expect(await laterReplay.json()).toMatchObject({
      reason: 'not_found',
      replay: true,
      scanId: scan?.id,
    });
    expect(await counter(counterKey, previousWindow)).toEqual({ count: 31 });
    expect(await counter(counterKey)).toBeNull();
    expect(await audits(scanner.id)).toHaveLength(1);
  });

  it.each(['scanner revoked', 'event archived', 'scope removed', 'session paused'] as const)(
    'does not count a stop if %s before its effect transaction',
    async (change) => {
      const event =
        change === 'event archived' ? await kit.event({ templateIds: [templateId] }) : null;
      const scanner = await kit.scanner(
        event ? { eventId: event.id } : { templateIds: [templateId] },
      );
      let sessionId: string | null = null;
      if (change === 'session paused') {
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
      const counterKey = scopedKey(kit.org.id, 'live', `s:${scanner.id}`);
      await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
        counterKey,
        windowStart(),
      ]);
      const idempotencyKey = key();
      const { response, scanId } = await atStopCommit(
        idempotencyKey,
        (db) => {
          if (change === 'scanner revoked')
            return run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
              kit.clock.now(),
              scanner.id,
            ]);
          if (change === 'event archived')
            return run(db, 'UPDATE scan_events SET archived_at=? WHERE id=?', [
              kit.clock.now(),
              event!.id,
            ]);
          if (change === 'session paused')
            return run(
              db,
              "UPDATE scanning_sessions SET status='paused',updated_at=updated_at+1 WHERE id=?",
              [sessionId],
            );
          return run(db, 'DELETE FROM scanner_templates WHERE scanner_id=? AND template_id=?', [
            scanner.id,
            templateId,
          ]);
        },
        () => kit.post(scanner.headers, '/actions', body(idempotencyKey, `MISS-${key()}`)),
      );
      await expectNotCounted(
        response,
        change === 'scanner revoked' ? 'SCANNER_REPAIR' : 'SCAN_CONFIG_CHANGED',
        scanId,
        counterKey,
        scanner.id,
      );
    },
  );

  it.each(['session', 'membership'] as const)(
    'does not count an admin stop when its %s is revoked before finalization',
    async (change) => {
      const user = await makeUser(kit.fx);
      const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, [
        'pass_operator',
      ]);
      const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
      const sessionId = await sha256Hex(session.cookieValue);
      const counterKey = scopedKey(kit.org.id, 'live', `u:${user.id}`);
      await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
        counterKey,
        windowStart(),
      ]);
      const idempotencyKey = key();
      const { response, scanId } = await atStopCommit(
        idempotencyKey,
        (db) =>
          change === 'session'
            ? run(db, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
                kit.clock.now(),
                sessionId,
              ])
            : run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
                kit.clock.now(),
                membershipId,
              ]),
        () =>
          Promise.resolve(
            app.request(
              `${ORIGIN}/api/v1/scan/actions`,
              {
                method: 'POST',
                headers: { ...session.headers, origin: ORIGIN, 'content-type': 'application/json' },
                body: JSON.stringify({
                  ...body(idempotencyKey, 'MISS-ADMIN'),
                  scope: { orgId: kit.org.id, timeZone: 'UTC' },
                }),
              },
              kit.env,
            ),
          ),
      );
      await expectNotCounted(response, 'ACTOR_CHANGED', scanId, counterKey, user.id);
    },
  );

  it('does not count when the pending claim changes before finalization', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const counterKey = scopedKey(kit.org.id, 'live', `s:${scanner.id}`);
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
      counterKey,
      windowStart(),
    ]);
    const idempotencyKey = key();
    const { response, scanId } = await atStopCommit(
      idempotencyKey,
      (db, id) => run(db, "UPDATE scans SET state='failed',reason='stale' WHERE id=?", [id]),
      () => kit.post(scanner.headers, '/actions', body(idempotencyKey, 'MISS-CLAIM')),
    );
    await expectNotCounted(response, 'SCAN_IN_PROGRESS', scanId, counterKey, scanner.id);
  });

  it('does not count when the presented credential retires before finalization', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const other = await kit.scanPass(templateId);
    // A real transfer needs a rotating barcode and no fixed lookup credential.
    const manifest = (await kit.registry.resolve(templateId)).manifest;
    expect(manifest.scan?.lookup).toBeUndefined();
    expect(manifest.bindings).toContainEqual({
      to: { barcode: 0, prop: 'message' },
      value: '{{pass.scanCode}}',
    });
    expect(other.identityId).toBeTruthy();
    expect(other.releaseId).toBeTruthy();
    const db = kit.env.DB;
    const input = { code: 'MISS-RETIRED-CREDENTIAL', method: 'camera' as const };
    const refs = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', input, false);
    const ref = refs.credentialTombstoneRefs[0];
    if (!ref) throw new Error('Missing credential reference');
    const counterKey = scopedKey(kit.org.id, 'live', `s:${scanner.id}`);
    await run(db, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
      counterKey,
      windowStart(),
    ]);
    const idempotencyKey = key();
    const { response, scanId } = await atStopCommit(
      idempotencyKey,
      async (real) => {
        await run(real, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
          await barcodeHashOfCode(cleanCode(input.code)),
          other.id,
        ]);
        const transfer = await startScanCredentialTransfer(kit, other.id, { db: real });
        expect(transfer.state).toBe('completed');
        expect(
          await first(
            real,
            'SELECT credential_hash FROM pass_credential_tombstones WHERE pass_id=? AND credential_hash=?',
            [other.id, ref],
          ),
        ).not.toBeNull();
      },
      () => kit.post(scanner.headers, '/actions', { ...body(idempotencyKey, input.code), input }),
    );
    await expectNotCounted(response, 'SCAN_PASS_CHANGED', scanId, counterKey, scanner.id);
  });

  it.each(['counter', 'audit'] as const)(
    'rolls back the completed event miss when its %s write is suppressed',
    async (failure) => {
      const event = await kit.event({ templateIds: [templateId] });
      const scanner = await kit.scanner({ eventId: event.id });
      const counterKey = scopedKey(kit.org.id, 'live', `s:${scanner.id}`);
      await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
        counterKey,
        windowStart(),
      ]);
      const idempotencyKey = key();
      const trigger = `miss_stop_ignore_${failure}`;
      const ddl =
        failure === 'counter'
          ? `CREATE TRIGGER ${trigger} BEFORE INSERT ON counters WHEN NEW.key LIKE 'scan:miss:%' BEGIN SELECT RAISE(IGNORE); END`
          : `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_log WHEN NEW.action='scan.misses_capped' BEGIN SELECT RAISE(IGNORE); END`;
      let raced: { response: Response; scanId: string };
      try {
        raced = await atStopCommit(
          idempotencyKey,
          (db) => run(db, ddl),
          () => kit.post(scanner.headers, '/actions', body(idempotencyKey, `MISS-${key()}`)),
        );
      } finally {
        await run(kit.env.DB, `DROP TRIGGER IF EXISTS ${trigger}`);
      }
      throw new Error('DBG '+raced.response.status+(await raced.response.clone().text()).slice(0,200)+JSON.stringify(await counter(counterKey))+JSON.stringify(await audits(scanner.id)));
      await expectNotCounted(
        raced.response,
        'SCAN_IN_PROGRESS',
        raced.scanId,
        counterKey,
        scanner.id,
      );
    },
  );
});
