import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';
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

describe('proof 2: three orgs, both modes, ten endpoints each, 500 random events', () => {
  it('every captured POST belongs to its endpoint tenant, and each endpoint gets exactly its feed rows', async () => {
    const random = mulberry32(20261118);
    const orgs = [rig.orgId, (await makeOrg(rig.kit.fx)).id, (await makeOrg(rig.kit.fx)).id];
    const tenants: { orgId: string; mode: Mode }[] = orgs.flatMap((orgId) =>
      (['live', 'test'] as const).map((mode) => ({ orgId, mode })),
    );
    const endpoints = new Map<string, { orgId: string; mode: Mode; types: string[] }>();
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
        `SELECT event_id FROM event_feed WHERE org_id = ? AND mode = ?
           AND type IN (${ep.types.map(() => '?').join(',')})`,
        [ep.orgId, ep.mode, ...ep.types],
      );
      expect([...(got.get(id) ?? [])].sort()).toEqual(rows.map((r) => r.event_id).sort());
      total += rows.length;
    }
    expect(total).toBeGreaterThan(500);
    expect(net.calls).toHaveLength(total);
  }, 180_000);
});
