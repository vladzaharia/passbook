import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makePass, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import type { Pass } from '../passes/repo-map.ts';
import { eventExpectedCountSql, expectedCount, todayStmt } from './repo-counts.ts';
import { eventTotalsStmt } from './repo-event-attendance.ts';
import {
  codeOf,
  grantScanMembership,
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupScanKit();
  kit.clock.set(Date.UTC(2026, 0, 1, 12));
  // The kit's fake session store cannot resolve cookies persisted by makeSession.
  app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
});

function post(headers: Record<string, string>, path: string, body: unknown) {
  return app.request(
    `${ORIGIN}/api/v1/scan${path}`,
    {
      method: 'POST',
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
}

async function record(
  pass: Pass,
  headers: Record<string, string>,
  eventId: string,
  idempotencyKey = key(),
) {
  const response = await post({ ...headers, 'x-passbook-mode': pass.mode }, '/actions', {
    input: codeOf(pass),
    idempotencyKey,
    clientTs: kit.clock.now(),
    actionId: 'check_in',
    scope: { orgId: pass.orgId, eventId, timeZone: 'UTC' },
  });
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as { kind: string; scanId: string; replay: boolean };
  expect(outcome.kind).toBe('ok');
  return outcome;
}

async function totals(orgId: string, mode: Mode, eventId: string) {
  return eventTotalsStmt(kit.env.DB, orgId, mode, eventId).first<{
    arrived: number;
    inside: number;
  }>();
}

async function projected(eventId: string) {
  return first<{ n: number }>(
    kit.env.DB,
    `SELECT ${eventExpectedCountSql('e', '?')} AS n FROM scan_events e WHERE e.id=?`,
    [kit.clock.now(), eventId],
  );
}

describe('scanner count scope and historical arrivals', () => {
  it('accepts a real scoped operator session but denies it after membership or session revocation', async () => {
    const user = await makeUser(kit.fx);
    const membership = await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    const template = await kit.scanTemplate('Scoped operator authority', { actions: [CHECK_IN] });
    const event = await kit.event({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    const outcome = await record(pass, session.headers, event.id);
    expect(outcome.scanId).toEqual(expect.any(String));
    expect(
      await first(
        kit.env.DB,
        'SELECT pass_id,event_id,outcome FROM scans WHERE id=? AND actor_id=?',
        [outcome.scanId, user.id],
      ),
    ).toEqual({ pass_id: pass.id, event_id: event.id, outcome: 'ok' });

    const rejected = await kit.scanPass(template);
    const body = {
      input: codeOf(rejected),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: CHECK_IN.id,
      scope: { orgId: kit.org.id, eventId: event.id, timeZone: 'UTC' },
    };
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      membership,
    ]);
    const unauthorized = await post(session.headers, '/actions', body);
    expect(unauthorized.status).toBe(403);
    expect(await unauthorized.json()).toMatchObject({ code: 'FORBIDDEN' });
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
      kit.clock.now(),
      await hashSessionCookie(session.cookieValue),
    ]);
    const unauthenticated = await post(session.headers, '/actions', body);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ code: 'SCANNER_UNAUTHENTICATED' });
    expect(
      await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM scans WHERE pass_id=?', [rejected.id]),
    ).toEqual({ n: 0 });
    expect(
      await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM scan_gates WHERE pass_id=?', [
        rejected.id,
      ]),
    ).toEqual({ n: 0 });
  });

  it('records a scoped operator refusal without creating a gate', async () => {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    const template = await kit.scanTemplate('Scoped refusal authority', { actions: [CHECK_IN] });
    const event = await kit.event({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
    const response = await post({ ...session.headers, 'x-passbook-mode': pass.mode }, '/actions', {
      input: codeOf(pass),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: CHECK_IN.id,
      scope: { orgId: pass.orgId, eventId: event.id, timeZone: 'UTC' },
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as {
      kind: string;
      reason: string;
      scanId: string;
    };
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'voided',
      scanId: expect.any(String),
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT pass_id,event_id,outcome,reason FROM scans WHERE id=? AND actor_id=?',
        [outcome.scanId, user.id],
      ),
    ).toEqual({ pass_id: pass.id, event_id: event.id, outcome: 'refused', reason: 'voided' });
    expect(
      await first(
        kit.env.DB,
        'SELECT excluded,invalidated FROM scan_retention_proofs WHERE scan_id=?',
        [outcome.scanId],
      ),
    ).toEqual({ excluded: 0, invalidated: 0 });
    expect(
      await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM scan_gates WHERE pass_id=?', [pass.id]),
    ).toEqual({ n: 0 });
  });

  it('scopes the same admin actor to each tenant and mode and excludes quarantined and corrupt issuance', async () => {
    const user = await makeUser(kit.fx);
    const other = await makeOrg(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    await grantScanMembership(kit.fx, other.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const scopes = [
      { orgId: kit.org.id, mode: 'live' as const, count: 1 },
      { orgId: kit.org.id, mode: 'test' as const, count: 2 },
      { orgId: other.id, mode: 'live' as const, count: 3 },
      { orgId: other.id, mode: 'test' as const, count: 4 },
    ];
    for (const scope of scopes) {
      const template = await kit.scanTemplate(
        'Scoped count',
        { actions: [CHECK_IN] },
        { orgId: scope.orgId },
      );
      const event = await kit.event({
        orgId: scope.orgId,
        mode: scope.mode,
        templateIds: [template],
      });
      for (let i = 0; i < scope.count; i++) {
        await record(await kit.scanPass(template, {}, scope), session.headers, event.id);
      }
      const quarantined = await kit.scanPass(template, {}, scope);
      const corrupt = await kit.scanPass(template, {}, scope);
      await record(quarantined, session.headers, event.id);
      await record(corrupt, session.headers, event.id);
      const foreignTemplate = await kit.scanTemplate(
        'Wrong issued release',
        { actions: [CHECK_IN] },
        { orgId: scope.orgId },
      );
      const foreignPass = await kit.scanPass(foreignTemplate, {}, scope);
      const release = await first<{ release_id: string }>(
        kit.env.DB,
        'SELECT release_id FROM passes WHERE id=?',
        [foreignPass.id],
      );
      if (!release?.release_id) throw new Error('Missing approved release');
      await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [
        quarantined.id,
      ]);
      await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [
        release.release_id,
        corrupt.id,
      ]);
      expect(await totals(scope.orgId, scope.mode, event.id)).toEqual({
        arrived: scope.count,
        inside: scope.count,
      });
      expect(await projected(event.id)).toEqual({ n: scope.count });
    }
    for (const scope of scopes) {
      expect(
        await todayStmt(
          kit.env.DB,
          `u:${user.id}`,
          scope.orgId,
          scope.mode,
          kit.clock.now(),
        ).first(),
      ).toEqual({ n: scope.count });
    }
  });

  it('retains historical arrivals but excludes no-longer-eligible passes from current expected counts', async () => {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const template = await kit.scanTemplate('Historical event counts', { actions: [CHECK_IN] });
    const event = await kit.event({ templateIds: [template] });
    const passes: Pass[] = [];
    for (let i = 0; i < 6; i++) {
      const pass = await kit.scanPass(template);
      passes.push(pass);
      await record(pass, session.headers, event.id);
    }
    await run(kit.env.DB, 'UPDATE passes SET deleted_at=1 WHERE id=?', [passes[0]!.id]);
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [passes[1]!.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at=1 WHERE id=?', [passes[2]!.id]);
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=? AND version=?",
      [new Date(kit.clock.now() - 60_000).toISOString(), passes[3]!.id, passes[3]!.version],
    );
    await run(kit.env.DB, "UPDATE pass_versions SET pass_json='{}' WHERE pass_id=? AND version=?", [
      passes[4]!.id,
      passes[4]!.version,
    ]);
    expect(await totals(kit.org.id, 'live', event.id)).toEqual({ arrived: 6, inside: 6 });
    expect(
      await todayStmt(kit.env.DB, `u:${user.id}`, kit.org.id, 'live', kit.clock.now()).first(),
    ).toEqual({ n: 6 });
    expect(
      await expectedCount(
        kit.env.DB,
        { orgId: kit.org.id, mode: 'live', matchInput: null, matchValues: null },
        [template],
        kit.clock.now(),
      ),
    ).toBe(1);
    expect(await projected(event.id)).toEqual({ n: 1 });
  });

  it('counts witnessed event presence for unscoped and daily gates, legacy gates, replay and undo', async () => {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const always = await kit.scanTemplate('Always gate', {
      actions: [{ ...CHECK_IN, repeat: 'always' }],
    });
    const daily = await kit.scanTemplate('Daily gate', {
      actions: [{ ...CHECK_IN, repeat: 'daily' }],
    });
    const once = await kit.scanTemplate('Legacy event gate', {
      actions: [{ ...CHECK_IN, repeat: 'once' }],
    });
    const event = await kit.event({ templateIds: [always, daily, once] });
    const a = await kit.scanPass(always);
    const b = await kit.scanPass(daily);
    const c = await kit.scanPass(once);
    const idempotencyKey = key();
    const admission = await record(a, session.headers, event.id, idempotencyKey);
    const replay = await record(a, session.headers, event.id, idempotencyKey);
    expect(replay).toMatchObject({ scanId: admission.scanId, replay: true });
    await record(b, session.headers, event.id);
    const legacyAdmission = await record(c, session.headers, event.id);
    expect(await first(kit.env.DB, 'SELECT scope FROM scan_gates WHERE pass_id=?', [a.id])).toEqual(
      { scope: '' },
    );
    expect(await first(kit.env.DB, 'SELECT scope FROM scan_gates WHERE pass_id=?', [b.id])).toEqual(
      { scope: 'day:2026-01-01' },
    );
    expect(
      await first(kit.env.DB, 'SELECT scope FROM scan_presence WHERE pass_id=?', [a.id]),
    ).toEqual({ scope: `event:${event.id}` });
    expect(
      await first(kit.env.DB, 'SELECT scope FROM scan_presence WHERE pass_id=?', [b.id]),
    ).toEqual({ scope: `event:${event.id}` });
    expect(await totals(kit.org.id, 'live', event.id)).toEqual({ arrived: 3, inside: 3 });

    // A legacy event gate still has the original successful admission witness.
    await run(kit.env.DB, 'DELETE FROM scan_presence WHERE pass_id=?', [c.id]);
    expect(await totals(kit.org.id, 'live', event.id)).toEqual({ arrived: 3, inside: 3 });
    const undo = await post(session.headers, `/scans/${admission.scanId}/undo`, {
      idempotencyKey: key(),
      scope: { orgId: kit.org.id, eventId: event.id, timeZone: 'UTC' },
    });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toMatchObject({ kind: 'ok' });
    expect(await totals(kit.org.id, 'live', event.id)).toEqual({ arrived: 2, inside: 2 });
    await run(kit.env.DB, 'UPDATE scans SET event_id=NULL WHERE id=?', [legacyAdmission.scanId]);
    expect(await totals(kit.org.id, 'live', event.id)).toEqual({ arrived: 1, inside: 1 });
  });

  it('excludes foreign pass relations while retaining legacy witnessed attendance', async () => {
    const user = await makeUser(kit.fx);
    const other = await makeOrg(kit.fx);
    const templateId = await kit.scanTemplate('Ledger relation scope', { actions: [CHECK_IN] });
    const foreignTemplateId = await kit.scanTemplate(
      'Foreign relation scope',
      { actions: [CHECK_IN] },
      { orgId: other.id },
    );
    const template = await kit.registry.resolve(templateId);
    const foreignTemplate = await kit.registry.resolve(foreignTemplateId);
    const event = await kit.event({ templateIds: [templateId] });
    const foreignIdentity = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
      (id,org_id,label,pass_type_identifier,team_identifier,source,env_prefix,created_at)
      VALUES (?,?,'Foreign',?,'FOREIGNTEAM','env','FOREIGN',?)`,
      [foreignIdentity, other.id, `pass.foreign.${kit.fx.ids.token(8)}`, kit.clock.now()],
    );
    const foreignConnection = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections(id,org_id,connector_type,name,created_at,updated_at)
      VALUES (?,?,'fixture','Foreign',?,?)`,
      [foreignConnection, other.id, kit.clock.now(), kit.clock.now()],
    );
    const good = await makePass(kit.fx, { orgId: kit.org.id, template });
    const wrongIdentity = await makePass(kit.fx, {
      orgId: kit.org.id,
      template,
      identityId: foreignIdentity,
    });
    const wrongConnection = await makePass(kit.fx, { orgId: kit.org.id, template });
    const wrongTemplate = await makePass(kit.fx, { orgId: kit.org.id, template: foreignTemplate });
    await run(kit.env.DB, 'UPDATE passes SET connection_id=? WHERE id=?', [
      foreignConnection,
      wrongConnection.id,
    ]);
    for (const [pass, passTemplate] of [
      [good, templateId],
      [wrongIdentity, templateId],
      [wrongConnection, templateId],
      [wrongTemplate, foreignTemplateId],
    ] as const) {
      const id = kit.fx.ids.id();
      await run(
        kit.env.DB,
        `INSERT INTO scans
        (id,org_id,mode,pass_id,template_id,event_id,actor_type,actor_id,actor_key,
          idempotency_key,request_hash,method,state,outcome,action_id,action_kind,at)
        VALUES (?,?,'live',?,?,?,'user',?,?,?,?,'camera','done','ok','check_in','check_in',?)`,
        [
          id,
          kit.org.id,
          pass.id,
          passTemplate,
          event.id,
          user.id,
          `u:${user.id}`,
          id,
          id,
          kit.clock.now(),
        ],
      );
      await run(
        kit.env.DB,
        `INSERT INTO scan_gates
        (pass_id,action_id,scope,org_id,mode,template_id,kind,state,count,first_at,last_at,last_scan_id)
        VALUES (?,'check_in',?,?,'live',?,'check_in','in',1,?,?,?)`,
        [
          pass.id,
          `event:${event.id}`,
          kit.org.id,
          passTemplate,
          kit.clock.now(),
          kit.clock.now(),
          id,
        ],
      );
    }
    expect(await totals(kit.org.id, 'live', event.id)).toEqual({ arrived: 1, inside: 1 });
    expect(
      await todayStmt(kit.env.DB, `u:${user.id}`, kit.org.id, 'live', kit.clock.now()).first(),
    ).toEqual({ n: 1 });
  });

  it('keeps generic ledger totals but never revives invalidated or quarantined attendance', async () => {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const template = await kit.scanTemplate('Attendance ABA', { actions: [CHECK_IN] });
    const event = await kit.event({ templateIds: [template] });
    const firstPass = await kit.scanPass(template);
    const quarantined = await kit.scanPass(template);
    const firstScan = await record(firstPass, session.headers, event.id);
    await record(quarantined, session.headers, event.id);
    expect(await totals(kit.org.id, 'live', event.id)).toEqual({ arrived: 2, inside: 2 });
    await run(kit.env.DB, 'UPDATE scans SET event_id=NULL WHERE id=?', [firstScan.scanId]);
    await run(kit.env.DB, 'UPDATE scans SET event_id=? WHERE id=?', [event.id, firstScan.scanId]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [quarantined.id]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=0 WHERE id=?', [quarantined.id]);
    expect(await totals(kit.org.id, 'live', event.id)).toEqual({ arrived: 0, inside: 0 });
    expect(
      await todayStmt(kit.env.DB, `u:${user.id}`, kit.org.id, 'live', kit.clock.now()).first(),
    ).toEqual({ n: 1 });
  });

  it('matches expectedCount for JSON-packed multiple filter values', async () => {
    const template = await kit.scanTemplate('Filtered event counts', { actions: [CHECK_IN] });
    const event = await kit.event({ templateIds: [template] });
    for (const tier of ['gold', 'silver', 'bronze', 'gold']) await kit.scanPass(template, { tier });
    const matchValues = JSON.stringify(['gold', 'silver']);
    await run(kit.env.DB, 'UPDATE scan_events SET match_input=?, match_values=? WHERE id=?', [
      'tier',
      matchValues,
      event.id,
    ]);
    expect(
      await expectedCount(
        kit.env.DB,
        { orgId: kit.org.id, mode: 'live', matchInput: 'tier', matchValues },
        [template],
        kit.clock.now(),
      ),
    ).toBe(3);
    expect(await projected(event.id)).toEqual({ n: 3 });
  });
  it('fails closed on invalid event filters and matches literal nonalphanumeric input keys', async () => {
    const template = await kit.scanTemplate('Filter boundaries', { actions: [CHECK_IN] });
    const event = await kit.event({ templateIds: [template] });
    const firstPass = await kit.scanPass(template, { tier: 'gold' });
    const secondPass = await kit.scanPass(template, { tier: 'silver' });
    await run(
      kit.env.DB,
      `UPDATE passes SET personalization=json_set(personalization, '$."membership.tier"', 'gold') WHERE id=?`,
      [firstPass.id],
    );
    await run(
      kit.env.DB,
      `UPDATE passes SET personalization=json_set(personalization, '$."membership.tier"', 'silver') WHERE id=?`,
      [secondPass.id],
    );
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization, '$.enabled', json('true')) WHERE id=?",
      [firstPass.id],
    );
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization, '$.enabled', json('false')) WHERE id=?",
      [secondPass.id],
    );
    const unicodeKey = '\u{1F600}'.repeat(64);
    const unicodeValue = '\u{1F49A}'.repeat(120);
    await run(
      kit.env.DB,
      'UPDATE passes SET personalization=json_set(personalization, ?, ?) WHERE id=?',
      [`$."${unicodeKey}"`, unicodeValue, firstPass.id],
    );

    // A CTE permits exercising corrupt persisted values despite the table's CHECK constraints.
    const cases: Array<[string | null, string | null, number]> = [
      [null, null, 2],
      [null, '["gold"]', 0],
      ['tier', null, 0],
      ['tier', '{', 0],
      ['tier', '{"value":"gold"}', 0],
      ['tier', 'null', 0],
      ['tier', '[]', 0],
      ['', '["gold"]', 0],
      ['x'.repeat(65), '["gold"]', 0],
      ['tier', '["gold",1]', 0],
      ['tier', '["gold",null]', 0],
      ['tier', '["gold",""]', 0],
      ['tier', JSON.stringify(['x'.repeat(121)]), 0],
      ['tier', JSON.stringify(Array(21).fill('gold')), 0],
      ['membership.tier', '["gold","silver"]', 2],
      ['membership.tier', '["gold"]', 1],
      ['enabled', '["1"]', 1],
      ['enabled', '["0"]', 1],
      ['enabled', '["true"]', 0],
      [unicodeKey, JSON.stringify([unicodeValue]), 1],
    ];
    for (const [matchInput, matchValues, count] of cases) {
      const row = await first<{ n: number }>(
        kit.env.DB,
        `WITH e AS (SELECT id, org_id, mode, ? AS match_input, ? AS match_values
          FROM scan_events WHERE id=?)
         SELECT ${eventExpectedCountSql('e', '?')} AS n FROM e`,
        [matchInput, matchValues, event.id, kit.clock.now()],
      );
      expect(row, `${matchInput}: ${matchValues}`).toEqual({ n: count });
      expect(
        await expectedCount(
          kit.env.DB,
          { orgId: kit.org.id, mode: 'live', matchInput, matchValues },
          [template],
          kit.clock.now(),
        ),
        `${matchInput}: ${matchValues}`,
      ).toBe(count);
    }
  });
});
