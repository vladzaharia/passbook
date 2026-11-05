import { describe, expect, it } from 'vitest';
import { fixtureInput, fixtureOutcome, states } from './fixtures.test-support.ts';
import { FIXTURE_NOW } from './reduce.test-support.ts';
import { reduce } from './reduce.ts';
import type { Cmd, FailCode, ScanEvent, ScanState } from './types.ts';

/** mulberry32: a seeded generator, no dependency. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** expect() is too slow for 80,000 steps; a failure still names the seed. */
function check(ok: boolean, what: string, seed: number, step: number) {
  if (!ok) throw new Error(`${what} (seed ${seed}, step ${step})`);
}

const CODES = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'];
const FAILS: FailCode[] = ['network', 'timeout', 'server', 'rate_limited', 'forbidden'];
const KINDS = ['ok', 'heads_up', 'refused', 'ready'] as const;

function sequence(seed: number, length: number) {
  const next = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  let n = 0;
  const id = () => `01900000-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`;
  let state: ScanState = next() < 0.5 ? states.ready() : { ...states.ready(), posture: 'desk' };
  let now = FIXTURE_NOW;
  const keys: string[] = [];
  for (let i = 0; i < length; i++) {
    now += pick([0, 10, 120, 350, 351, 1200, 5000, 31_000]);
    const roll = next();
    let event: ScanEvent;
    if (roll < 0.35) {
      const code = pick(CODES);
      event = { type: 'read', input: fixtureInput({ code, sig: `c:${code}`, id: id(), at: now }) };
    } else if (roll < 0.55) {
      const key = pick(keys.length ? keys : ['none']);
      const kind = pick(KINDS);
      event = {
        type: 'answer',
        key,
        outcome: fixtureOutcome(kind, kind === 'heads_up' ? 'already_done' : null),
      };
    } else if (roll < 0.65) {
      event = { type: 'fail', key: pick(keys.length ? keys : ['none']), error: pick(FAILS) };
    } else if (roll < 0.8) {
      event = { type: 'tick' };
    } else if (roll < 0.9) {
      event = { type: 'dismiss' };
    } else if (roll < 0.95) {
      event = { type: 'override', actionId: 'check_in' };
    } else {
      event = pick<ScanEvent>([
        { type: 'visible', visible: false },
        { type: 'resume' },
        { type: 'online', online: next() < 0.5 },
        { type: 'switch' },
        { type: 'keep' },
      ]);
    }
    const before = state;
    const res = reduce(state, event, { now, id });
    const requests = res.cmds.filter((c: Cmd) => c.c === 'resolve' || c.c === 'act');
    for (const r of requests) if ('key' in r) keys.push(r.key);
    const inFlight = before.loop.s === 'checking' || before.loop.s === 'applying';
    // Never two loop requests in flight.
    check(requests.length <= 1, 'two requests in one step', seed, i);
    // A new request starts only once the old one has finished (answered, failed or timed out).
    if (inFlight && requests.length > 0) {
      check(['answer', 'fail', 'tick'].includes(event.type), 'request while in flight', seed, i);
      check(before.loop !== res.state.loop, 'request without leaving the loop state', seed, i);
    }
    // Never a timed close of a heads_up.
    if (
      event.type === 'tick' &&
      before.loop.s === 'verdict' &&
      before.loop.outcome.kind === 'heads_up' &&
      before.loop.next === null
    )
      check(res.state.loop.s === 'verdict', 'a heads_up closed on a timer', seed, i);
    check(res.state.ignore.length <= 20, 'ignore over 20', seed, i);
    check(res.state.recent.length <= 20, 'recent over 20', seed, i);
    state = res.state;
  }
}

describe('reduce property', () => {
  it('holds its invariants over 2,000 seeded sequences', () => {
    for (let seed = 1; seed <= 2000; seed++) sequence(seed, 40);
    expect(true).toBe(true);
  }, 120_000);
});
