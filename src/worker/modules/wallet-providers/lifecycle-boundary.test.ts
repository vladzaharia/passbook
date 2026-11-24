import { beforeAll, describe, expect, it } from 'vitest';
import type { PassJson } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  events,
  HOUR,
  MIN,
  seasonKit,
  seasonPass,
} from '../passes/event-boundaries-test-fixtures.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { currentPassJson } from '../passes/repo-read-pass.ts';
import { timedPassJson } from '../passes/timed-pass.ts';
import { nextInstanceBoundary, walletBoundaries } from './lifecycle-boundary.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await seasonKit();
});

describe('wallet card boundaries', () => {
  it("are Apple's: each start, each end after the template's event length, and the expiry", async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['Open', now + HOUR], ['Gala', now + 4 * HOUR]));
    const expiry = now + 30 * HOUR;
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [new Date(expiry).toISOString(), pass.id],
    );
    const ctx = jobCtxOf(kit);
    expect(await walletBoundaries(ctx, pass.id)).toEqual([
      now + HOUR,
      now + HOUR + 90 * MIN + 1,
      now + 4 * HOUR,
      now + 4 * HOUR + 90 * MIN + 1,
      expiry,
    ]);
    kit.clock.set(now + HOUR);
    // The event's end, not the next start, is when the card next changes.
    expect(await nextInstanceBoundary(ctx, pass.id)).toBe(now + HOUR + 90 * MIN + 1);
  });

  it('are none for a pass with no events and no expiry', async () => {
    const pass = await kit.pass();
    expect(await walletBoundaries(jobCtxOf(kit), pass.id)).toEqual([]);
  });

  it('compile the card a wallet shows now: the running event, not the one built', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(
      kit,
      events(['A', now + HOUR, now + 2 * HOUR], ['B', now + 3 * HOUR]),
    );
    const built = JSON.parse((await currentPassJson(kit.env.DB, pass.id)) ?? '{}') as PassJson;
    const at = (t: number) =>
      timedPassJson(built, pass.personalization, kit.template, t).upcomingPassInformation?.map(
        (e) => `${e.name}${e.isActive ? '*' : ''}`,
      );
    expect(at(now)).toEqual(['A', 'B']);
    expect(at(now + HOUR)).toEqual(['A*', 'B']);
    expect(at(now + 2 * HOUR + 1)).toEqual(['B']);
  });
});
