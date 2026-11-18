import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run } from '../../platform/db.ts';
import { recordAppleEvents } from '../apple/events.ts';
import { recordEmailOutcome } from '../delivery/email-outcome.ts';
import { handlePushDeliver } from '../delivery/jobs.ts';
import { enqueuePush } from '../delivery/service.ts';
import { recordPassEvent } from '../events/record.ts';
import {
  drain,
  endpointWithSecret,
  type Net,
  type Rig,
  setupRig,
  stubNet,
} from './deliver-test-fixtures.ts';
import { dispatchDue } from './dispatch.ts';

let rig: Rig;
let net: Net;

beforeAll(async () => {
  rig = await setupRig();
  net = stubNet();
});
afterAll(() => net.restore());

/** Deterministic PRNG, so a failure reproduces. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: [string, Record<string, string | number>][] = [
  ['pass.updated', { cause: 'publish', version: 2 }],
  ['pass.voided', {}],
  ['pass.unvoided', {}],
  ['pass.restored', {}],
  ['push.failed', { status: 400 }],
  ['scan.checked_in', {}],
  ['scan.heads_up', {}],
  ['scan.rejected', {}],
  ['scan.undone', {}],
  ['email.failed', { code: 'X' }],
];
const TYPE_OF: Record<string, string> = {
  'scan.checked_in': 'pass.scanned',
  'scan.heads_up': 'pass.scanned',
  'scan.rejected': 'pass.scan_refused',
  'scan.undone': 'pass.scan_undone',
};
const TYPES = [...new Set([...KINDS.map(([k]) => TYPE_OF[k] ?? k), 'pass.issued'])];

type Endpoints = Map<string, { orgId: string; mode: Mode; types: string[] }>;

/** Every captured POST belongs to its endpoint's tenant, and each endpoint got exactly its feed rows. */
async function expectExactDeliveries(endpoints: Endpoints, min = 500, afterSeq = 0) {
  const url = new Map([...endpoints].map(([id]) => [`https://hooks.example.com/${id}`, id]));
  const got = new Map<string, Set<string>>();
  for (const call of net.calls) {
    const id = url.get(call.url);
    expect(id, `a POST to an unknown URL: ${call.url}`).toBeDefined();
    const ep = endpoints.get(id as string) as { orgId: string; mode: Mode };
    const body = JSON.parse(call.body) as { id: string; orgId: string; mode: Mode };
    expect(body.orgId).toBe(ep.orgId);
    expect(body.mode).toBe(ep.mode);
    const set = got.get(id as string) ?? new Set<string>();
    expect(set.has(body.id), 'an event delivered twice').toBe(false);
    set.add(body.id);
    got.set(id as string, set);
  }
  let total = 0;
  for (const [id, ep] of endpoints) {
    const rows = await all<{ event_id: string }>(
      rig.db,
      `SELECT event_id FROM event_feed WHERE org_id = ? AND mode = ? AND seq > ?
           AND type IN (${ep.types.map(() => '?').join(',')})`,
      [ep.orgId, ep.mode, afterSeq, ...ep.types],
    );
    expect([...(got.get(id) ?? [])].sort()).toEqual(rows.map((r) => r.event_id).sort());
    total += rows.length;
  }
  expect(total).toBeGreaterThan(min);
  expect(net.calls).toHaveLength(total);
}

describe('proof 2: three orgs, both modes, ten endpoints each, 500 random events', () => {
  it('every captured POST belongs to its endpoint tenant, and each endpoint gets exactly its feed rows', async () => {
    const random = mulberry32(20261118);
    const orgs = [rig.orgId, (await makeOrg(rig.kit.fx)).id, (await makeOrg(rig.kit.fx)).id];
    const tenants: { orgId: string; mode: Mode }[] = orgs.flatMap((orgId) =>
      (['live', 'test'] as const).map((mode) => ({ orgId, mode })),
    );
    const endpoints: Endpoints = new Map();
    for (const t of tenants)
      for (let i = 0; i < 10; i++) {
        const types = TYPES.filter(() => random() < 0.4);
        if (types.length === 0) types.push('pass.updated');
        const id = await endpointWithSecret(rig, { ...t, eventTypes: types });
        endpoints.set(id, { ...t, types });
      }
    const passes = [];
    for (const t of tenants) passes.push({ ...t, pass: await rig.kit.pass(t) });

    for (let i = 0; i < 500; i++) {
      const p = passes[Math.floor(random() * passes.length)] as (typeof passes)[number];
      const [kind, data] = KINDS[Math.floor(random() * KINDS.length)] as (typeof KINDS)[number];
      await recordPassEvent(rig.kit.ctx, {
        orgId: p.orgId,
        passId: p.pass.id,
        mode: p.mode,
        kind: kind as 'pass.updated',
        data,
      });
    }

    await dispatchDue(rig.ctx, 1000);
    await drain(rig, 5000);

    await expectExactDeliveries(endpoints);
  }, 180_000);

  it('holds through the real Apple, push and email writers', async () => {
    net.calls.length = 0;
    await run(rig.db, 'DELETE FROM webhook_endpoints');
    rig.hooks.sent.length = 0;
    const afterSeq =
      (await first<{ m: number }>(rig.db, 'SELECT max(seq) AS m FROM event_feed'))?.m ?? 0;
    const orgs = [rig.orgId, (await makeOrg(rig.kit.fx)).id];
    const endpoints: Endpoints = new Map();
    for (const orgId of orgs)
      for (let i = 0; i < 10; i++) {
        const types = [...TYPES];
        endpoints.set(await endpointWithSecret(rig, { orgId, mode: 'live', eventTypes: types }), {
          orgId,
          mode: 'live',
          types,
        });
      }
    const kit = rig.kit;
    for (const orgId of orgs) {
      const base = { orgId, mode: 'live' as const };
      for (let n = 0; n < 3; n++) {
        const pass = await kit.pass({ orgId });
        const at = { serial: pass.serial, credentialGeneration: pass.credentialGeneration };
        const d = `dev-${pass.id}`;
        await kit.device(pass, d, 'a'.repeat(64));
        await recordAppleEvents(kit.ctx, [
          { ...base, passId: pass.id, ...at, kind: 'device.registered', device: d },
        ]);
        await run(rig.db, 'DELETE FROM registrations WHERE pass_id = ? AND device_id = ?', [
          pass.id,
          d,
        ]);
        await recordAppleEvents(kit.ctx, [
          {
            ...base,
            passId: pass.id,
            ...at,
            kind: 'device.unregistered',
            device: d,
            data: { reason: 'device' },
          },
        ]);
        const gone = 'b'.repeat(64);
        await kit.device(pass, `g-${pass.id}`, gone);
        await enqueuePush(rig.ctx, pass.id, 'refresh');
        await kit.settle();
        const outbox = await first<{ id: string }>(
          rig.db,
          "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
          [pass.id],
        );
        kit.apns.results.set(gone, { status: 400, reason: 'BadDeviceToken' });
        try {
          await handlePushDeliver({ kind: 'push.deliver', outboxId: outbox?.id ?? '' }, rig.ctx);
        } finally {
          kit.apns.results.delete(gone);
        }
        await recordEmailOutcome(
          kit.ctx,
          { id: `ob-${pass.id}` } as never,
          { orgId, passId: pass.id, mode: 'live', templateId: null, identityId: null },
          'failed',
          'EMAIL_FAILED',
        );
      }
    }
    await dispatchDue(rig.ctx, 1000);
    await drain(rig, 5000);
    await expectExactDeliveries(endpoints, 100, afterSeq);
  }, 180_000);
});
