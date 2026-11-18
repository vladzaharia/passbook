import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { recordAppleEvents } from '../apple/events.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { recordEmailOutcome } from '../delivery/email-outcome.ts';
import { handlePushDeliver } from '../delivery/jobs.ts';
import { enqueuePush } from '../delivery/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { codeOf, key, type ScanKit, setupScanKit } from '../scan/test-kit.ts';
import { buildEnvelope } from './payload.ts';
import { feedRowOf } from './repo-feed.ts';
import {
  ALL_TYPES,
  countOf,
  deliveriesOf,
  type EndpointSeed,
  feedOf,
  seedEndpoint,
} from './webhooks-test-fixtures.ts';

let kit: ScanKit;
let orgId: string;
let endpoints: string[];
const db = () => kit.env.DB;

beforeAll(async () => {
  kit = await setupScanKit();
  orgId = kit.org.id;
  // The hot-path worst case: the cap, every endpoint subscribed to everything.
  endpoints = [];
  for (let i = 0; i < 10; i++)
    endpoints.push(await seedEndpoint(db(), { orgId, eventTypes: ALL_TYPES }));
});

const base = (passId: string) => ({ orgId, passId, mode: 'live' as const });

/** The feed rows of a pass, each fanned out to all ten endpoints exactly once. */
async function expectFeed(passId: string, types: string[]) {
  const rows = await feedOf(db(), passId);
  expect(rows.map((r) => r.type)).toEqual(types);
  for (const r of rows) {
    expect(await countOf(db(), 'webhook_deliveries', `event_seq = ${r.seq}`)).toBe(10);
    expect(await countOf(db(), 'event_feed', `event_id = '${r.event_id}'`)).toBe(1);
  }
  return rows;
}

describe('every ledger writer path writes exactly one feed row, with ten endpoints present', () => {
  it('recordPassEvents: each catalog kind maps to its type', async () => {
    const cases: [string, string, Record<string, unknown>?][] = [
      ['pass.updated', 'pass.updated', { cause: 'publish', version: 2 }],
      ['pass.voided', 'pass.voided'],
      ['pass.unvoided', 'pass.unvoided'],
      ['pass.removed', 'pass.removed', { version: 3, message: true }],
      ['pass.restored', 'pass.restored'],
      ['email.failed', 'email.failed', { code: 'X' }],
      ['push.failed', 'push.failed', { status: 400 }],
      ['scan.checked_in', 'pass.scanned'],
      ['scan.redeemed', 'pass.scanned'],
      ['scan.adjusted', 'pass.scanned'],
      ['scan.checked_out', 'pass.scanned'],
      ['scan.heads_up', 'pass.scanned'],
      ['scan.rejected', 'pass.scan_refused'],
      ['scan.undone', 'pass.scan_undone'],
    ];
    const pass = await kit.pass();
    for (const [kind, , data] of cases)
      await recordPassEvent(kit.ctx, {
        ...base(pass.id),
        kind: kind as 'pass.updated',
        data: data as never,
      });
    await expectFeed(pass.id, ['pass.issued', ...cases.map(([, type]) => type)]);
  });

  it('pass create writes pass.issued', async () => {
    const pass = await kit.pass();
    await expectFeed(pass.id, ['pass.issued']);
  });

  it('Apple register and unregister: deviceCount counts after the change', async () => {
    const pass = await kit.pass();
    const at = { serial: pass.serial, credentialGeneration: pass.credentialGeneration };
    await kit.device(pass, `d1-${pass.id}`, 'a'.repeat(64));
    await recordAppleEvents(kit.ctx, [
      { ...base(pass.id), ...at, kind: 'device.registered', device: `d1-${pass.id}` },
    ]);
    await kit.device(pass, `d2-${pass.id}`, 'b'.repeat(64));
    await recordAppleEvents(kit.ctx, [
      { ...base(pass.id), ...at, kind: 'device.registered', device: `d2-${pass.id}` },
    ]);
    for (const d of ['d2', 'd1']) {
      await run(db(), 'DELETE FROM registrations WHERE pass_id = ? AND device_id = ?', [
        pass.id,
        `${d}-${pass.id}`,
      ]);
      await recordAppleEvents(kit.ctx, [
        {
          ...base(pass.id),
          ...at,
          kind: 'device.unregistered',
          device: `${d}-${pass.id}`,
          data: { reason: 'device' },
        },
      ]);
    }
    const rows = await expectFeed(pass.id, [
      'pass.issued',
      'pass.installed',
      'pass.installed',
      'pass.uninstalled',
      'pass.uninstalled',
    ]);
    expect(rows.map((r) => r.device_count)).toEqual([null, 1, 2, 1, 0]);
  });

  it('push failed and push gone', async () => {
    const pass = await kit.pass();
    const A = 'a'.repeat(64);
    await kit.device(pass, `push-${pass.id}`, A);
    await enqueuePush(jobCtxOf(kit), pass.id, 'refresh');
    await kit.settle();
    const outbox = await first<{ id: string }>(
      db(),
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
      [pass.id],
    );
    kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
    try {
      await handlePushDeliver({ kind: 'push.deliver', outboxId: outbox?.id ?? '' }, jobCtxOf(kit));
    } finally {
      kit.apns.results.delete(A);
    }
    const rows = await expectFeed(pass.id, ['pass.issued', 'push.failed', 'pass.uninstalled']);
    expect(JSON.parse(rows[2]?.data ?? '{}')).toMatchObject({ reason: 'push_gone' });
    // The registration is dropped before the event, so the journal counts the devices left.
    expect(rows[2]?.device_count).toBe(0);
  });

  it('push gone for two devices: every event reports the devices left once the batch is dropped', async () => {
    const pass = await kit.pass();
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    await kit.device(pass, `g1-${pass.id}`, A);
    await kit.device(pass, `g2-${pass.id}`, B);
    await enqueuePush(jobCtxOf(kit), pass.id, 'refresh');
    await kit.settle();
    const outbox = await first<{ id: string }>(
      db(),
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
      [pass.id],
    );
    kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
    kit.apns.results.set(B, { status: 400, reason: 'BadDeviceToken' });
    try {
      await handlePushDeliver({ kind: 'push.deliver', outboxId: outbox?.id ?? '' }, jobCtxOf(kit));
    } finally {
      kit.apns.results.delete(A);
      kit.apns.results.delete(B);
    }
    const gone = (await feedOf(db(), pass.id)).filter((r) => r.type === 'pass.uninstalled');
    expect(gone).toHaveLength(2);
    // Never `lastDevice: false` while no device is left (the receiver would wait for one that never comes).
    for (const r of gone)
      expect(buildEnvelope(feedRowOf(r)).data).toMatchObject({ deviceCount: 0, lastDevice: true });
  });

  it('deviceCount ignores registrations of another credential generation', async () => {
    const pass = await kit.pass();
    await kit.device(pass, `cur-${pass.id}`, 'c'.repeat(64));
    await run(
      db(),
      `INSERT INTO devices (device_id, identity_id, push_token, updated_at)
       SELECT ?, identity_id, ?, 1 FROM passes WHERE id = ?`,
      [`old-${pass.id}`, 'd'.repeat(64), pass.id],
    );
    await run(
      db(),
      `INSERT INTO registrations (device_id, identity_id, pass_id, created_at, credential_generation)
       SELECT ?, identity_id, id, 1, credential_generation + 1 FROM passes WHERE id = ?`,
      [`old-${pass.id}`, pass.id],
    );
    await recordPassEvent(kit.ctx, { ...base(pass.id), kind: 'device.registered', device: 'x' });
    expect((await feedOf(db(), pass.id)).at(-1)?.device_count).toBe(1);
  });

  it('email.failed through its real writer', async () => {
    const pass = await kit.pass();
    await recordEmailOutcome(
      kit.ctx,
      { id: 'outbox-1' } as never,
      { orgId, passId: pass.id, mode: 'live', templateId: null, identityId: null },
      'failed',
      'EMAIL_FAILED',
    );
    const rows = await expectFeed(pass.id, ['pass.issued', 'email.failed']);
    expect(buildEnvelope(feedRowOf(rows[1] as never)).data).toEqual({ code: 'EMAIL_FAILED' });
  });

  describe('scan', () => {
    let templateId: string;
    const scope = () => ({ orgId, timeZone: 'UTC' });
    const act = async (pass: Awaited<ReturnType<ScanKit['scanPass']>>) =>
      kit.post(kit.admin(), '/actions', {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'enter',
        scope: scope(),
      });

    beforeAll(async () => {
      templateId = await kit.scanTemplate('Door ticket', {
        actions: [{ id: 'enter', label: 'Check in', kind: 'check_in', repeat: 'once' }],
      });
    });

    it('redeem and adjust through the scanner API', async () => {
      const t = await kit.scanTemplate('Credit', {
        actions: [
          { id: 'add', label: 'Add', kind: 'add', input: 'balance', repeat: 'always', amount: 1 },
          { id: 'use', label: 'Use', kind: 'use_up' },
        ],
      });
      const pass = await kit.scanPass(t, { balance: 5 });
      const post = (actionId: string) =>
        kit.post(kit.admin(), '/actions', {
          idempotencyKey: key(),
          input: codeOf(pass),
          clientTs: kit.clock.now(),
          actionId,
          scope: scope(),
        });
      expect(((await (await post('add')).json()) as ScanOutcome).kind).toBe('ok');
      expect(((await (await post('use')).json()) as ScanOutcome).kind).toBe('ok');
      const rows = await feedOf(db(), pass.id);
      // The value change also publishes (pass.updated); the scans are the scanned rows.
      expect(rows.filter((r) => r.type === 'pass.scanned').map((r) => r.kind)).toEqual([
        'scan.adjusted',
        'scan.redeemed',
      ]);
      for (const r of rows)
        expect(await countOf(db(), 'webhook_deliveries', `event_seq = ${r.seq}`)).toBe(10);
    });

    it('act, refuse and undo', async () => {
      const pass = await kit.scanPass(templateId);
      const res = await act(pass);
      const ok = (await res.json()) as ScanOutcome;
      expect(ok.kind).toBe('ok');
      // A repeat of a once-only action is a heads-up: still a scan, outcome heads_up.
      await act(pass);
      const voided = await kit.scanPass(templateId);
      await run(db(), "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
      await act(voided);
      const undo = await kit.post(kit.admin(), `/scans/${ok.scanId}/undo`, {
        idempotencyKey: key(),
        scope: scope(),
      });
      expect(undo.status).toBe(200);
      const rows = await feedOf(db(), pass.id);
      expect(rows.map((r) => r.type)).toEqual([
        'pass.issued',
        'pass.scanned',
        'pass.scanned',
        'pass.scan_undone',
      ]);
      expect(JSON.parse(rows[2]?.data ?? '{}')).toMatchObject({ outcome: 'heads_up' });
      const refused = await feedOf(db(), voided.id);
      expect(refused.map((r) => r.type)).toEqual(['pass.issued', 'pass.scan_refused']);
      for (const r of [...rows, ...refused])
        expect(await countOf(db(), 'webhook_deliveries', `event_seq = ${r.seq}`)).toBe(10);
    });
  });
});

describe('feed exclusions', () => {
  it('skips a resign update', async () => {
    const pass = await kit.pass();
    const before = (await feedOf(db(), pass.id)).length;
    await recordPassEvent(kit.ctx, {
      ...base(pass.id),
      kind: 'pass.updated',
      data: { cause: 'resign' },
    });
    expect((await feedOf(db(), pass.id)).length).toBe(before);
  });

  it('keeps a pass.updated whose cause is absent or null', async () => {
    const pass = await kit.pass();
    await recordPassEvent(kit.ctx, { ...base(pass.id), kind: 'pass.updated', data: {} });
    await recordPassEvent(kit.ctx, {
      ...base(pass.id),
      kind: 'pass.updated',
      data: { cause: null },
    });
    expect((await feedOf(db(), pass.id)).map((r) => r.type)).toEqual([
      'pass.issued',
      'pass.updated',
      'pass.updated',
    ]);
  });

  it('skips a test row on a live pass', async () => {
    const pass = await kit.pass();
    const before = (await feedOf(db(), pass.id)).length;
    await recordPassEvent(kit.ctx, { ...base(pass.id), mode: 'test', kind: 'pass.voided' });
    expect(await countOf(db(), 'pass_events', `pass_id = '${pass.id}' AND mode = 'test'`)).toBe(1);
    expect((await feedOf(db(), pass.id)).length).toBe(before);
  });

  it.each([
    ['a quarantined pass', 'test_data_quarantined = 1'],
    ['a deleted pass', 'deleted_at = 5'],
  ])('skips %s', async (_label, set) => {
    const pass = await kit.pass();
    const before = (await feedOf(db(), pass.id)).length;
    await run(db(), `UPDATE passes SET ${set} WHERE id = ?`, [pass.id]);
    await recordPassEvent(kit.ctx, { ...base(pass.id), kind: 'pass.voided' });
    expect((await feedOf(db(), pass.id)).length).toBe(before);
  });

  it('skips a suspended org', async () => {
    const other = await kit.pass();
    const before = (await feedOf(db(), other.id)).length;
    await run(db(), "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
    try {
      await recordPassEvent(kit.ctx, { ...base(other.id), kind: 'pass.voided' });
    } finally {
      await run(db(), "UPDATE orgs SET status = 'active' WHERE id = ?", [orgId]);
    }
    expect((await feedOf(db(), other.id)).length).toBe(before);
  });

  it('the events.feed kill switch skips the whole body', async () => {
    const pass = await kit.pass();
    const before = await countOf(db(), 'event_feed');
    const deliveries = await countOf(db(), 'webhook_deliveries');
    await run(
      db(),
      `INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'events.feed', '"off"', 1)`,
    );
    try {
      await recordPassEvent(kit.ctx, { ...base(pass.id), kind: 'pass.voided' });
      expect(await countOf(db(), 'event_feed')).toBe(before);
      expect(await countOf(db(), 'webhook_deliveries')).toBe(deliveries);
    } finally {
      await run(db(), "DELETE FROM settings WHERE scope = 'platform' AND key = 'events.feed'");
    }
    await recordPassEvent(kit.ctx, { ...base(pass.id), kind: 'pass.unvoided' });
    expect(await countOf(db(), 'event_feed')).toBe(before + 1);
  });
});

describe('fan-out', () => {
  it('goes only to active or paused endpoints whose type and template filter match', async () => {
    const f = kit.fx;
    const org = await makeOrg(f);
    const pass = await kit.pass({ orgId: org.id });
    const mk = (extra: Omit<EndpointSeed, 'orgId'>) =>
      seedEndpoint(db(), { orgId: org.id, ...extra });
    const match = await mk({ eventTypes: ['pass.voided'] });
    const paused = await mk({ eventTypes: ['pass.voided'], status: 'paused' });
    const disabled = await mk({ eventTypes: ['pass.voided'], status: 'disabled' });
    const otherType = await mk({ eventTypes: ['pass.scanned'] });
    const templateMatch = await mk({ eventTypes: ['pass.voided'], templateIds: [kit.template.id] });
    const templateMiss = await mk({ eventTypes: ['pass.voided'], templateIds: ['other-template'] });
    const testMode = await mk({ eventTypes: ['pass.voided'], mode: 'test' });
    await recordPassEvent(kit.ctx, {
      orgId: org.id,
      passId: pass.id,
      mode: 'live',
      kind: 'pass.voided',
    });
    const got = async (id: string) => (await deliveriesOf(db(), id)).length;
    expect(await got(match)).toBe(1);
    expect(await got(paused)).toBe(1);
    expect(await got(templateMatch)).toBe(1);
    for (const id of [disabled, otherType, templateMiss, testMode]) expect(await got(id)).toBe(0);
  });
});

describe('cost on the hot path', () => {
  it('writes one feed row and at most ten deliveries per ledger row', async () => {
    const pass = await kit.pass();
    const before = {
      feed: await countOf(db(), 'event_feed'),
      deliveries: await countOf(db(), 'webhook_deliveries'),
    };
    await recordPassEvent(kit.ctx, { ...base(pass.id), kind: 'pass.voided' });
    expect(await countOf(db(), 'event_feed')).toBe(before.feed + 1);
    expect(await countOf(db(), 'webhook_deliveries')).toBe(before.deliveries + endpoints.length);
    expect(endpoints.length).toBeLessThanOrEqual(10);
  });
});
