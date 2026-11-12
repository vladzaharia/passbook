import { beforeAll, describe, expect, it } from 'vitest';
import {
  effects,
  type Suite,
  scenario,
  send,
  signed,
  suite,
} from './action-gate-stale-budget-core-test-fixtures.ts';

let base: Suite;
beforeAll(async () => {
  base = await suite();
});

describe('approved action: signed results', () => {
  it('commits and signs a cold photo, history and tracked event check-in', async () => {
    const s = await scenario(base, { event: true, tracked: true, photo: true });
    const outcome = await send(s);
    expect(outcome).toMatchObject({
      kind: 'ok',
      scanId: expect.any(String),
      checkIn: { direction: 'in' },
      counts: { event: { arrived: 1 } },
    });
    expect(outcome.display?.identity.photo?.url).toContain(
      `/passes/${s.pass.id}/assets/member.png?g=`,
    );
    if (!outcome.scanId) throw new Error('Missing approved check-in');
    const proof = await signed(s, outcome.scanId);
    expect(proof.scan.approvedBy).toBe(s.manager.id);
    expect(proof.effect).toMatchObject({
      gateBefore: null,
      presenceBefore: null,
      gateAfter: { state: 'in', count: 1, lastScanId: outcome.scanId },
      presenceAfter: { state: 'in', lastScanId: outcome.scanId },
    });
    const after = await effects(s.kit.env.DB, s);
    expect(after.gates).toHaveLength(1);
    expect(after.presence).toHaveLength(1);
    expect(after.events).toHaveLength(1);
    expect(after.retention).toHaveLength(1);
  });

  it('records a truthful signed held-gate heads-up without changing the winning gate', async () => {
    const s = await scenario(base, { photo: true });
    const won = await send(s);
    if (!won.scanId) throw new Error('Missing winning scan');
    await signed(s, won.scanId);
    const before = await effects(s.kit.env.DB, s);
    const held = await send(s);
    expect(held).toMatchObject({
      kind: 'heads_up',
      reason: 'already_done',
      scanId: expect.any(String),
      previous: { scanId: won.scanId },
    });
    if (!held.scanId) throw new Error('Missing held-gate scan');
    const proof = await signed(s, held.scanId);
    expect(proof.effect.gateBefore).toEqual(proof.effect.gateAfter);
    expect(proof.effect.presenceBefore).toEqual(proof.effect.presenceAfter);
    const after = await effects(s.kit.env.DB, s);
    expect(after.gates).toEqual(before.gates);
    expect(after.presence).toEqual(before.presence);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.retention).toHaveLength(before.retention.length + 1);
  });
});
