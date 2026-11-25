import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { clearMarks, db, person, world } from './access-test-fixtures.ts';
import {
  BACKOFF_MS,
  clearDirty,
  dirtyCount,
  dueDirty,
  failDirty,
  markDirty,
} from './repo-dirty.ts';
import {
  clearHold,
  countsByTarget,
  failedStates,
  heldTargets,
  holdTarget,
  recordApplied,
  recordError,
  recordObserved,
  stateOf,
  statesOfSubject,
  statesOfUser,
} from './repo-state.ts';

const f = await world();
const now = f.clock.now();

describe('the dirty queue', () => {
  it('lists due marks oldest first and clears only the version it read', async () => {
    const subjects = ['q-a', 'q-b', 'q-c'];
    await clearMarks(subjects);
    await markDirty(db(), 'q-b');
    await markDirty(db(), 'q-a');
    await run(db(), 'UPDATE idp_dirty SET next_at = 50 WHERE subject = ?', ['q-b']);
    await markDirty(db(), 'q-c');
    await run(db(), 'UPDATE idp_dirty SET next_at = ? WHERE subject = ?', [now + 10, 'q-c']);
    const due = (await dueDirty(db(), now, 100)).filter((r) => subjects.includes(r.subject));
    expect(due.map((r) => r.subject)).toEqual(['q-a', 'q-b']);
    expect(due.find((r) => r.subject === 'q-b')?.next_at).toBe(50);
    expect((await dueDirty(db(), now, 1)).length).toBe(1);

    const read = due.find((r) => r.subject === 'q-a');
    await markDirty(db(), 'q-a'); // a source changed while the drain ran
    expect(await clearDirty(db(), 'q-a', read?.version ?? 0)).toBe(false);
    const again = (await dueDirty(db(), now, 100)).find((r) => r.subject === 'q-a');
    expect(again?.version).toBe((read?.version ?? 0) + 1);
    expect(await clearDirty(db(), 'q-a', again?.version ?? 0)).toBe(true);
    expect(await dirtyCount(db())).toBeGreaterThan(0);
  });

  it('backs off 1 minute, 5 minutes, 30 minutes, then 6 hours, and a new mark resets it', async () => {
    await clearMarks(['q-fail']);
    await markDirty(db(), 'q-fail');
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const [row] = (await dueDirty(db(), Number.MAX_SAFE_INTEGER, 100)).filter(
        (r) => r.subject === 'q-fail',
      );
      expect(row?.attempts).toBe(i);
      expect(await failDirty(db(), 'q-fail', row?.version ?? 0, now)).toBe(true);
      const [after] = (await dueDirty(db(), Number.MAX_SAFE_INTEGER, 100)).filter(
        (r) => r.subject === 'q-fail',
      );
      seen.push((after?.next_at ?? 0) - now);
    }
    expect(seen).toEqual([...BACKOFF_MS, BACKOFF_MS[3], BACKOFF_MS[3]]);
    expect((await dueDirty(db(), now, 100)).some((r) => r.subject === 'q-fail')).toBe(false);
    await markDirty(db(), 'q-fail');
    expect((await dueDirty(db(), now, 100)).find((r) => r.subject === 'q-fail')?.attempts).toBe(0);
  });

  it('does not back off a mark that arrived after the read', async () => {
    await clearMarks(['q-late']);
    await markDirty(db(), 'q-late');
    const [row] = (await dueDirty(db(), now, 100)).filter((r) => r.subject === 'q-late');
    await markDirty(db(), 'q-late');
    expect(await failDirty(db(), 'q-late', row?.version ?? 0, now)).toBe(false);
    expect((await dueDirty(db(), now, 100)).some((r) => r.subject === 'q-late')).toBe(true);
  });
});

describe('the projection cache', () => {
  const obs = (subject: string, target: 'console' | 'developer' | `g:${string}`, over = {}) => ({
    subject,
    target,
    userId: null,
    observed: true,
    presence: 'passbook' as const,
    now,
    ...over,
  });

  it('records what was seen, keeps the user once known, and clears the last error', async () => {
    const p = await person(f);
    await recordError(db(), p.subject, 'console', null, 'IDP_UPSTREAM');
    expect((await stateOf(db(), p.subject, 'console'))?.error_code).toBe('IDP_UPSTREAM');
    expect((await failedStates(db(), 100)).some((r) => r.subject === p.subject)).toBe(true);
    await recordObserved(db(), obs(p.subject, 'console', { userId: p.id }));
    await recordObserved(
      db(),
      obs(p.subject, 'console', { observed: false, presence: 'none', now: now + 5 }),
    );
    expect(await stateOf(db(), p.subject, 'console')).toMatchObject({
      user_id: p.id,
      observed: 0,
      presence: 'none',
      observed_at: now + 5,
      error_code: null,
    });
    expect((await statesOfUser(db(), p.id)).map((r) => r.target)).toEqual(['console']);
  });

  it('stamps applied_at only on an apply', async () => {
    const p = await person(f);
    await recordObserved(db(), obs(p.subject, 'developer'));
    expect((await stateOf(db(), p.subject, 'developer'))?.applied_at).toBeNull();
    await recordApplied(db(), obs(p.subject, 'developer', { now: now + 9 }));
    expect((await stateOf(db(), p.subject, 'developer'))?.applied_at).toBe(now + 9);
  });

  it('holds a target from the first time, survives observations, and Restore clears it once', async () => {
    const p = await person(f);
    await recordObserved(db(), obs(p.subject, 'console'));
    await holdTarget(db(), p.subject, 'console', p.id, now + 1);
    await holdTarget(db(), p.subject, 'console', p.id, now + 2);
    expect(await stateOf(db(), p.subject, 'console')).toMatchObject({
      held_at: now + 1,
      observed: 0,
      presence: 'none',
    });
    await recordObserved(db(), obs(p.subject, 'console', { observed: false, presence: 'none' }));
    expect([...(await heldTargets(db(), p.subject))]).toEqual(['console']);
    expect(await clearHold(db(), p.subject, 'console')).toBe(true);
    expect(await clearHold(db(), p.subject, 'console')).toBe(false);
    expect((await heldTargets(db(), p.subject)).size).toBe(0);
  });

  it('counts by target: seen, added by PassBook, external and held', async () => {
    const a = await person(f);
    const b = await person(f);
    const target = `g:count_${a.id
      .slice(-8)
      .replace(/[^a-z0-9]/g, 'x')
      .toLowerCase()}` as `g:${string}`;
    await recordObserved(db(), obs(a.subject, target));
    await recordObserved(db(), obs(b.subject, target, { presence: 'external' }));
    const c = await person(f);
    await holdTarget(db(), c.subject, target, c.id, now);
    const row = (await countsByTarget(db())).find((r) => r.target === target);
    expect(row).toEqual({ target, observed: 2, passbook: 1, external: 1, held: 1 });
    expect((await statesOfSubject(db(), a.subject)).map((r) => r.target)).toEqual([target]);
  });
});
