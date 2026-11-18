import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignCmd,
  bindResultOf,
  cardReadEvent,
  enrollmentOf,
  run,
  tagReadEvent,
} from './assign.test-support.ts';
import { assignOf, requestOf, stripOfAssign } from './assign-view.ts';
import { fixtureState } from './fixtures.test-support.ts';
import { at, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';
import type { ScanState } from './types.ts';

beforeEach(resetIds);
const idle = (): ScanState => fixtureState({ started: true, camera: 'live' });

describe('a request arrives on an idle scanner', () => {
  it('opens the card at once with the pass known, the chirp and the announcement', () => {
    const r = step(idle(), { type: 'enroll.arrive', request: enrollmentOf() }, at(0));
    expect(assignOf(r.state)).toMatchObject({
      source: 'request',
      step: 'tag',
      request: { holderName: 'Maya Okafor' },
      idleAt: at(90_000),
    });
    expect(r.cmds).toContainEqual({ c: 'sound', tone: 'heads_up' });
    expect(r.cmds).toContainEqual(
      expect.objectContaining({ c: 'announce', text: expect.stringContaining('Maya Okafor') }),
    );
    expect(requestOf(r.state)?.opened).toBe(true);
  });

  it('is ignored when it has already expired, or is already showing', () => {
    const late = step(
      idle(),
      { type: 'enroll.arrive', request: enrollmentOf({ expiresAt: at(-1) }) },
      at(0),
    );
    expect(assignOf(late.state)).toBeNull();
    const r = step(idle(), { type: 'enroll.arrive', request: enrollmentOf() }, at(0));
    const twice = step(r.state, { type: 'enroll.arrive', request: enrollmentOf() }, at(10));
    expect(twice.cmds).toEqual([]);
  });
});

describe('a request arrives while the scanner is busy', () => {
  it('waits as a chip while a result is up, and opens when the result goes', () => {
    const scanned = step(idle(), readOf('CARD-0001'), at(0));
    const key = requestKey(scanned.cmds);
    const verdict = step(scanned.state, { type: 'answer', key, outcome: await0(key) }, at(50));
    expect(verdict.state.loop.s).toBe('verdict');
    const arrived = step(
      verdict.state,
      { type: 'enroll.arrive', request: enrollmentOf() },
      at(100),
    );
    expect(assignOf(arrived.state)).toBeNull();
    expect(requestOf(arrived.state)).toMatchObject({ opened: false });
    const closed = step(arrived.state, { type: 'dismiss' }, at(200));
    expect(assignOf(closed.state)).toMatchObject({ source: 'request' });
  });

  it('Later keeps the chip and keeps the card closed; Open opens it over a draft', () => {
    const open = step(idle(), { type: 'assign.open', from: 'menu' }, at(0));
    const arrived = step(open.state, { type: 'enroll.arrive', request: enrollmentOf() }, at(100));
    expect(assignOf(arrived.state)?.source).toBe('menu');
    const later = step(arrived.state, { type: 'enroll.later' }, at(110));
    expect(requestOf(later.state)).toMatchObject({ opened: false, later: true });
    const cancelled = step(later.state, { type: 'assign.cancel' }, at(120));
    expect(assignOf(cancelled.state)).toBeNull();
    expect(requestOf(cancelled.state)?.later).toBe(true);
    const now = step(cancelled.state, { type: 'enroll.open' }, at(130));
    expect(assignOf(now.state)).toMatchObject({ source: 'request' });
  });
});

describe('completing and ending a request', () => {
  const arrived = () =>
    step(idle(), { type: 'enroll.arrive', request: enrollmentOf() }, at(0)).state;

  it('a tag read completes the request with no card and no confirm', () => {
    const r = run(arrived(), [100, tagReadEvent()]);
    const cmd = assignCmd(r.cmds, 'enroll.complete');
    expect(cmd).toMatchObject({ id: enrollmentOf().id, tag: { uid: '04a2b3c4d5e6f7' } });
    const done = step(
      r.state,
      {
        type: 'assign.bound',
        key: cmd.key,
        result: bindResultOf({ status: 'bound', bindingId: 'b9' }),
      },
      at(200),
    );
    expect(assignOf(done.state)).toMatchObject({ step: 'done', source: 'request' });
  });

  it('a pass scanned during the request is an amber note and the request continues', () => {
    const r = step(arrived(), cardReadEvent(), at(100));
    expect(assignOf(r.state)).toMatchObject({ step: 'tag', note: { kind: 'is_pass' } });
  });

  it('a tag error leaves the request open for another tag', () => {
    const r = run(arrived(), [100, tagReadEvent()]);
    const { key } = assignCmd(r.cmds, 'enroll.complete');
    const f = step(
      r.state,
      { type: 'assign.failed', key, code: 'TAG_LOST', status: 409, network: false },
      at(200),
    );
    expect(assignOf(f.state)).toMatchObject({ step: 'error', error: { kind: 'lost' } });
    const again = step(f.state, { type: 'assign.again', keepPass: true }, at(300));
    expect(assignOf(again.state)).toMatchObject({
      source: 'request',
      step: 'tag',
      request: { id: enrollmentOf().id },
    });
  });

  it("a tag on another holder's pass waits for the console", () => {
    const r = run(arrived(), [100, tagReadEvent()]);
    const { key } = assignCmd(r.cmds, 'enroll.complete');
    const f = step(
      r.state,
      { type: 'assign.failed', key, code: 'TAG_HELD_BY_OTHER', status: 409, network: false },
      at(200),
    );
    expect(assignOf(f.state)).toMatchObject({ waiting: true, step: 'tag' });
  });

  it('Cancel declines the request and the strip says Tag request cancelled', () => {
    const r = step(arrived(), { type: 'assign.cancel' }, at(100));
    expect(r.cmds).toContainEqual({ c: 'enroll.decline', id: enrollmentOf().id });
    expect(stripOfAssign(r.state)?.kind).toBe('requestCancelled');
    expect(requestOf(r.state)).toBeNull();
  });

  it('the admin cancelling closes it with Cancelled in the console, and sends nothing', () => {
    const r = step(arrived(), { type: 'enroll.cancelled', id: enrollmentOf().id }, at(100));
    expect(assignOf(r.state)).toBeNull();
    expect(stripOfAssign(r.state)?.kind).toBe('adminCancelled');
    expect(r.cmds).toEqual([]);
  });

  it('cancelling a request that is not showing just drops the chip', () => {
    const open = step(idle(), { type: 'assign.open', from: 'menu' }, at(0)).state;
    const chip = step(open, { type: 'enroll.arrive', request: enrollmentOf() }, at(10)).state;
    const gone = step(chip, { type: 'enroll.cancelled', id: enrollmentOf().id }, at(20));
    expect(requestOf(gone.state)).toBeNull();
    expect(assignOf(gone.state)?.source).toBe('menu');
  });

  it('expires while the card shows: Tag request timed out', () => {
    const r = step(arrived(), { type: 'tick' }, at(90_000));
    expect(assignOf(r.state)).toBeNull();
    expect(stripOfAssign(r.state)?.kind).toBe('requestTimedOut');
    expect(requestOf(r.state)).toBeNull();
  });

  it('expires during a scan: the request ends, not the scan in flight on the server', () => {
    // A tag was read at 89 s and the call is out: the device waits for the answer instead of timing out.
    const r = run(arrived(), [89_000, tagReadEvent()]);
    const t = step(r.state, { type: 'tick' }, at(91_000));
    expect(assignOf(t.state)).toMatchObject({ busy: 'complete' });
    const { key } = assignCmd(r.cmds, 'enroll.complete');
    const f = step(
      t.state,
      { type: 'assign.failed', key, code: 'TAG_REQUEST_EXPIRED', status: 409, network: false },
      at(91_100),
    );
    expect(assignOf(f.state)).toBeNull();
    expect(stripOfAssign(f.state)?.kind).toBe('requestTimedOut');
  });

  it('a request that arrives mid-scan waits, then expires without ever opening', () => {
    const open = step(idle(), { type: 'assign.open', from: 'menu' }, at(0)).state;
    const chip = step(
      open,
      { type: 'enroll.arrive', request: enrollmentOf({ expiresAt: at(30_000) }) },
      at(10),
    ).state;
    const t = step(chip, { type: 'tick' }, at(30_000));
    expect(requestOf(t.state)).toBeNull();
    expect(assignOf(t.state)?.source).toBe('menu');
  });

  it.each([
    ['TAG_REQUEST_REVOKED', 'adminCancelled'],
    ['ENROLLMENT_ENDED', 'requestTimedOut'],
    ['ENROLLMENT_NOT_FOUND', 'requestTimedOut'],
  ] as const)('%s ends the request with %s and keeps the scanner running', (code, kind) => {
    const r = run(arrived(), [100, tagReadEvent()]);
    const { key } = assignCmd(r.cmds, 'enroll.complete');
    const status = code === 'ENROLLMENT_NOT_FOUND' ? 404 : 409;
    const f = step(r.state, { type: 'assign.failed', key, code, status, network: false }, at(200));
    expect(assignOf(f.state)).toBeNull();
    expect(stripOfAssign(f.state)?.kind).toBe(kind);
  });

  it('a pass that changed hands ends the card with the copy deck line and only Done', () => {
    const r = run(arrived(), [100, tagReadEvent()]);
    const { key } = assignCmd(r.cmds, 'enroll.complete');
    const f = step(
      r.state,
      { type: 'assign.failed', key, code: 'TAG_HOLDER_CHANGED', status: 409, network: false },
      at(200),
    );
    expect(assignOf(f.state)).toMatchObject({ step: 'error', error: { kind: 'holder_changed' } });
  });

  it('never opens on a blocked or offline scanner', () => {
    const blocked = step(
      { ...idle(), block: 'revoked' },
      { type: 'enroll.arrive', request: enrollmentOf() },
      at(0),
    );
    expect(assignOf(blocked.state)).toBeNull();
    const offline = step(
      { ...idle(), online: false },
      { type: 'enroll.arrive', request: enrollmentOf() },
      at(0),
    );
    expect(assignOf(offline.state)).toBeNull();
    const back = step(offline.state, { type: 'online', online: true }, at(10));
    expect(assignOf(back.state)?.source).toBe('request');
  });
});

import { fixtureOutcome } from './fixture-data.test-support.ts';

const await0 = (_key: string) => fixtureOutcome('ok', null);
