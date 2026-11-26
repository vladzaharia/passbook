import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { toDto } from './dto.ts';
import { ORG_KIND, registerTestKinds } from './operations-test-fixtures.ts';
import { progressOf } from './progress.ts';
import { rowById } from './repo.ts';
import { sweepStalledOperations } from './stalls.ts';
import { startOperation } from './start.ts';

const HOUR = 3_600_000;
const MINUTE = 60_000;
let kit: Kit;
let undo: () => void;

beforeEach(async () => {
  kit = await setupKit();
  undo = registerTestKinds({});
});
afterEach(() => undo());

const start = (k = kit.ctx.ids.id()) =>
  startOperation(kit.ctx, {
    kind: ORG_KIND.kind,
    org: { orgId: kit.org.id, mode: 'live' },
    actor: { type: 'user', id: 'u1' },
    subject: { k },
  });
const resent = (id: string) =>
  kit.queue.sent.filter((m) => (m as { operationId?: string }).operationId === id).length;

/** One rule for a timed wait: planned until it ends, a lost wake-up once the look is `LOST_LOOK_GRACE_MS` late. */
describe('stall sweep: timed waits', () => {
  it('leaves a non-tail wait alone until its time passes, then resends once (R3-L1)', async () => {
    const op = await start();
    await progressOf(kit.ctx, op.id, 1).waiting('a', {
      until: kit.clock.now() + 2 * HOUR,
      due: true,
    });
    kit.clock.advance(HOUR);
    await sweepStalledOperations(kit.ctx);
    expect(resent(op.id)).toBe(0);
    expect(toDto((await rowById(kit.env.DB, op.id)) as never).status).toBe('waiting');
    // The wait is over and nothing woke it: now it is a lost wake-up.
    kit.clock.advance(2 * HOUR);
    await sweepStalledOperations(kit.ctx);
    expect(resent(op.id)).toBe(1);
  });

  it('finds a lost wake-up behind a crowd of tail-only waits (R3-L2)', async () => {
    for (let i = 0; i < 105; i++) {
      const op = await start(`crowd-${i}`);
      const p = progressOf(kit.ctx, op.id, 1);
      await p.step('a').done();
      await p.step('b').done();
      await p.waiting('c', { until: kit.clock.now() + 7 * 24 * HOUR, due: true });
    }
    kit.clock.advance(2 * MINUTE);
    const lost = await start('lost');
    await progressOf(kit.ctx, lost.id, 1).waiting('a', {
      until: kit.clock.now() + 1000,
      due: true,
    });
    kit.clock.advance(HOUR);
    await sweepStalledOperations(kit.ctx);
    expect(resent(lost.id)).toBe(1);
  });

  it('a wait with steps pending behind it is planned until it ends (N2)', async () => {
    const op = await start();
    const p = progressOf(kit.ctx, op.id, 1);
    await p.waiting('a', { until: kit.clock.now() + 90 * MINUTE, due: true });
    for (let at = 0; at < 90 * MINUTE; at += 3 * MINUTE) {
      kit.clock.advance(3 * MINUTE);
      await sweepStalledOperations(kit.ctx);
    }
    expect(resent(op.id)).toBe(0);
  });

  it('a wake-up a little late is not a stall; a look lost for the grace is (N2)', async () => {
    const op = await start();
    await progressOf(kit.ctx, op.id, 1).waiting('a', {
      until: kit.clock.now() + 30 * MINUTE,
      due: true,
    });
    kit.clock.advance(30 * MINUTE + 10 * MINUTE);
    await sweepStalledOperations(kit.ctx);
    expect(resent(op.id)).toBe(0);
    kit.clock.advance(11 * MINUTE);
    await sweepStalledOperations(kit.ctx);
    expect(resent(op.id)).toBe(1);
  });
});
