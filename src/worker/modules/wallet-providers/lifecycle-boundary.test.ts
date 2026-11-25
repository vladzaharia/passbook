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
import type { WalletOperation } from './instance-types.ts';
import { nextInstanceBoundary, walletBoundaries } from './lifecycle-boundary.ts';
import { samsungOperationState } from './sync-samsung-state.ts';

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

describe('a season past the cap of 10', () => {
  let season: Kit;
  beforeAll(async () => {
    season = await seasonKit({ schedule: { leadMinutes: 0 } });
  });

  it('keeps every event as a boundary and expires the card after the last one', async () => {
    const now = season.clock.now();
    const games = Array.from({ length: 12 }, (_, i): [string, number, number] => [
      `Game ${i + 1}`,
      now + (i + 1) * 2 * HOUR,
      now + (i + 1) * 2 * HOUR + HOUR,
    ]);
    const pass = await seasonPass(season, events(...games));
    const ctx = jobCtxOf(season);
    const boundaries = await walletBoundaries(ctx, pass.id);
    // The 11th and 12th games are past the built list's cap and still count.
    for (const [, start, end] of games)
      expect(boundaries).toEqual(expect.arrayContaining([start, end + 1]));
    expect(boundaries.at(-2)).toBe(now + 25 * HOUR);
    const op = {
      kind: 'upsert',
      passId: pass.id,
      instanceId: 'none',
      version: 1,
    } as WalletOperation;
    // Past the built expiry (the 10th game's end) the timed card is still live.
    season.clock.set(now + 22 * HOUR);
    expect(await samsungOperationState(ctx, op)).toBe('UPDATED');
    season.clock.set(now + 26 * HOUR);
    expect(await samsungOperationState(ctx, op)).toBe('EXPIRED');
  });
});
