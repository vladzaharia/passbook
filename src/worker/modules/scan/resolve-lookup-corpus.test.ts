import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './actor.ts';
import type { LookupEntry } from './lookup-history.ts';
import { grantReadMiss } from './misses.ts';
import { fixture, kit, setupReadMissGrant, templateId } from './read-miss-grant-test-fixtures.ts';
import { lookupPassesStmt } from './repo-lookup-final.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import {
  passAnswerFence,
  passLineageFence,
  refsClear,
  underAuthority,
} from './repo-read-fences.ts';
import {
  absent,
  acceptedFilter,
  matchingPassSql,
  passlessStmt,
} from './repo-resolve-passless-read.ts';
import { searchWindowUnchanged } from './repo-search.ts';
import { copyScanEpochs, setScanEpochs } from './scan-epochs.ts';

/*
 * The widest shape of each read of resolve and lookup: the actor on an event with a session and a
 * template list, three keyed refs, five candidates, a long query. Each stays within the bind budget
 * and compiles on D1 without a balancer.
 */

beforeAll(setupReadMissGrant);

const HEX = (c: string) => c.repeat(64);
const REFS = [HEX('a'), HEX('b'), HEX('c')];

function wide(actor: ScanActor): ScanActor {
  const event = {
    id: 'event-wide',
    orgId: actor.orgId,
    mode: actor.mode,
    name: 'Wide',
    matchInput: 'tier',
    matchValues: JSON.stringify(['gold', 'silver']),
    opensAt: 0,
    closesAt: 1,
    timeZone: 'UTC',
    capacity: null,
    reentry: false,
    note: null,
    updatedAt: 1,
    archivedAt: null,
  };
  const widened: ScanActor = {
    ...actor,
    event,
    templateIds: ['t1', 't2', 't3'],
    scanningSession: { id: 'ss-wide', status: 'active', updatedAt: 1 },
  };
  copyScanEpochs(actor, widened);
  const epochs = structuredClone(
    (actor as unknown as Record<symbol, unknown>)[Object.getOwnPropertySymbols(actor)[0]!] as never,
  ) as { events: Record<string, number>; session?: { id: string; config: number } };
  epochs.events['event-wide'] = 1;
  epochs.session = { id: 'ss-wide', config: 1 };
  setScanEpochs(widened, epochs as never);
  return widened;
}

const candidate = (
  actor: ScanActor,
  id: string,
): Pick<LookupEntry['source'], 'pass' | 'templateSnapshot'> =>
  ({
    pass: {
      id,
      orgId: actor.orgId,
      mode: actor.mode,
      credentialGeneration: 1,
      lifecycleGeneration: 0,
      imageGeneration: 0,
    } as Pass,
    templateSnapshot: {
      raw: JSON.stringify({
        release: { id: 'r', generation: 1, version: 'v', candidateHash: 'h' },
      }),
    },
  }) as never;

describe('the widest resolve and lookup reads', () => {
  it('the resolve answer fence stays under 90 binds and compiles', async () => {
    const f = await fixture();
    const actor = wide(f.actor);
    const auth = scanReadAuthority(actor, { now: kit.clock.now(), event: actor.event });
    const inner = passAnswerFence(actor, candidate(actor, 'p1'), { photo: true, refs: REFS });
    if (!inner) throw new Error('fence');
    const fence = underAuthority(auth, inner);
    expect(fence.params.length).toBeLessThanOrEqual(90);
    expect(
      await first(
        kit.env.DB,
        `SELECT CASE WHEN (${fence.sql}) THEN 1 ELSE 0 END AS ok`,
        fence.params,
      ),
    ).toEqual({ ok: 0 });
  });

  it('the passless read with five candidates, both refs sets and an appeared pass compiles', async () => {
    const f = await fixture();
    const actor = wide(f.actor);
    const auth = scanReadAuthority(actor, { now: kit.clock.now() });
    const match = {
      scanCode: 'S'.repeat(26),
      barcodeHash: HEX('d'),
      lookupHash: HEX('e'),
      serial: 'x'.repeat(40),
    };
    const lineage = Array.from({ length: 5 }, (_, i) =>
      passLineageFence(actor, candidate(actor, `p${i}`).pass, true),
    );
    const parts = [
      refsClear(REFS),
      refsClear(REFS, { org: 'ao.org_id', mode: "'test'" }),
      absent(
        matchingPassSql(match, { org: 'ao.org_id', mode: 'ao.mode' }, acceptedFilter(actor, true)),
      ),
      ...lineage,
    ].map((part) => {
      if (!part) throw new Error('part');
      return part;
    });
    const stmt = passlessStmt(kit.env.DB, auth, parts);
    expect((await stmt.all()).results).toEqual([]);
  });

  it('a lookup page of 60 entries is one statement, with a row per entry for a live actor', async () => {
    const f = await fixture();
    const entries = Array.from({ length: 60 }, (_, i) => ({
      source: candidate(f.actor, `p${i}`),
    })) as unknown as LookupEntry[];
    const real = lookupPassesStmt(
      kit.env.DB,
      scanReadAuthority(f.actor, { now: kit.clock.now() }),
      f.actor,
      entries,
      REFS,
    );
    if (!real) throw new Error('stmt');
    expect((await real.all()).results).toHaveLength(60);
    // The widened actor is no real one (its event is not stored): the statement compiles, and no row comes back.
    const actor = wide(f.actor);
    const widened = lookupPassesStmt(
      kit.env.DB,
      scanReadAuthority(actor, { now: kit.clock.now() }),
      actor,
      entries,
      REFS,
    );
    if (!widened) throw new Error('stmt');
    expect((await widened.all()).results).toEqual([]);
  });

  it('the widest search window fits an assert and the miss counts through it', async () => {
    const f = await fixture();
    const actor = wide(f.actor);
    const keys = {
      scanCode: 'S'.repeat(26),
      barcodeHash: HEX('d'),
      lookupHash: HEX('e'),
    };
    const q = 'q'.repeat(300);
    const window = searchWindowUnchanged(actor, q, null, keys, kit.clock.now(), REFS, 7);
    if (!window) throw new Error('window');
    expect(window.params.length).toBeLessThanOrEqual(40);
    // The same window under the actor's real tenant: counts, as 7 matches were observed and none exist.
    const plain = f.actor;
    const real = searchWindowUnchanged(
      plain,
      q,
      null,
      keys,
      kit.clock.now(),
      f.credentials.credentialTombstoneRefs,
      0,
    );
    if (!real) throw new Error('window');
    expect(
      await grantReadMiss(kit.ctx, plain, {
        refs: f.credentials.credentialTombstoneRefs,
        unchanged: real,
      }),
    ).toBe('counted');
    expect(templateId).toBeTruthy();
  });
});
