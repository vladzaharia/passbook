import { describe, expect, it } from 'vitest';
import type { PassEventDto } from '@/shared/contracts/events.ts';
import { duration, eventLabel, groupEvents, pushReason } from './sync-model.ts';

let n = 0;
const ev = (
  kind: PassEventDto['kind'],
  at: number,
  data: PassEventDto['data'] = {},
  device: string | null = null,
): PassEventDto => ({
  id: `e${++n}`,
  passId: 'p1',
  mode: 'live',
  kind,
  device,
  actorType: null,
  actorId: null,
  data,
  at,
});
const newestFirst = (list: PassEventDto[]) => [...list].sort((a, b) => b.at - a.at);

describe('duration', () => {
  it.each([
    [12_000, '12 s'],
    [180_000, '3 min'],
    [7_200_000, '2 h'],
  ])('%d ms is %s', (ms, text) => expect(duration(ms)).toBe(text));
});

describe('groupEvents', () => {
  it('folds a version, its push and its fetches into one row', () => {
    const rows = groupEvents(
      newestFirst([
        ev('pass.updated', 1000, { version: 7, notified: false }),
        ev('push.queued', 1001, { version: 7, devices: 2 }),
        ev('push.sent', 2000, { version: 7, status: 200 }, 'aaaaaaaaaaaa'),
        ev('push.sent', 2000, { version: 7, status: 200 }, 'bbbbbbbbbbbb'),
        ev('device.fetched', 14_000, { step: 'file', version: 7, status: 200 }, 'aaaaaaaaaaaa'),
        ev('device.fetched', 13_000, { step: 'listed', version: 7 }, 'aaaaaaaaaaaa'),
        ev('device.unregistered', 20_000, { reason: 'device' }, 'bbbbbbbbbbbb'),
      ]),
    );
    expect(rows.map((r) => r.title)).toEqual(['Updated to v7']);
    const group = rows[0];
    expect(group?.id).toBe('v7');
    expect(group?.group).toBe(true);
    expect(group?.facts.map((f) => f.text)).toEqual([
      'Pushed to 2 devices',
      '1 fetched in 13 s',
      '1 device stopped updates',
    ]);
    expect(group?.tone).toBe('success');
    expect(group?.events.map((e) => e.kind)).toContain('device.fetched');
  });

  it('counts devices that fetched, not fetch requests', () => {
    const rows = groupEvents(
      newestFirst([
        ev('pass.updated', 1000, { version: 3 }),
        ev('push.sent', 1500, { version: 3 }, 'aaaaaaaaaaaa'),
        ev('device.fetched', 2000, { step: 'file', version: 3, status: 200 }, 'aaaaaaaaaaaa'),
        ev('device.fetched', 2500, { step: 'file', version: 3, status: 304 }, 'aaaaaaaaaaaa'),
        ev('device.fetched', 2600, { step: 'file', version: 3, status: 200 }),
      ]),
    );
    expect(rows[0]?.facts.map((f) => f.text)).toContain('1 fetched in 1 s');
  });

  it('says so when nothing was registered, or the push is not set up', () => {
    const none = groupEvents([
      ev('push.queued', 2, { version: 2, devices: 0 }),
      ev('pass.updated', 1, { version: 2 }),
    ]);
    expect(none[0]?.facts).toEqual([{ text: 'No devices registered', tone: 'neutral' }]);
    const unset = groupEvents([
      ev('push.failed', 3, { version: 2, code: 'PUSH_UNAVAILABLE' }),
      ev('push.queued', 2, { version: 2, devices: 1 }),
      ev('pass.updated', 1, { version: 2 }),
    ]);
    expect(unset[0]?.tone).toBe('danger');
    expect(unset[0]?.facts.map((f) => f.text)).toContain('Push is not set up');
  });

  it('flags a pushed version nobody fetched, and failed pushes with the reason', () => {
    const waiting = groupEvents([
      ev('push.sent', 3, { version: 4, status: 200 }, 'aaaaaaaaaaaa'),
      ev('pass.updated', 1, { version: 4 }),
    ]);
    expect(waiting[0]?.tone).toBe('warning');
    expect(waiting[0]?.facts.map((f) => f.text)).toContain('Not fetched yet');
    const failed = groupEvents([
      ev('push.failed', 3, { version: 4, status: 400, reason: 'PayloadEmpty' }, 'aaaaaaaaaaaa'),
      ev('pass.updated', 1, { version: 4 }),
    ]);
    expect(failed[0]?.facts.map((f) => f.text)).toContain('1 push failed: Apple rejected the push');
  });

  it('keeps other events as rows of their own, newest first', () => {
    const rows = groupEvents([
      ev('email.failed', 30, { code: 'EMAIL_FAILED' }),
      ev('page.opened', 20),
      ev('device.log', 10, { line: 'update failed' }),
    ]);
    expect(rows.map((r) => r.title)).toEqual([
      'Email failed',
      'Pass page opened',
      'Wallet log line',
    ]);
    expect(rows[0]?.tone).toBe('danger');
    expect(rows.every((r) => !r.group)).toBe(true);
  });
});

describe('plain reasons', () => {
  it('maps transport strings to sentences and pluralizes pushes', () => {
    expect(pushReason('NetworkError:Error')).toBe('Could not reach Apple');
    expect(pushReason('BadDeviceToken')).toBe('Device token no longer valid');
    const rows = groupEvents([
      ev('push.failed', 4, { version: 3, reason: 'NetworkError:Error' }, 'aaaaaaaaaaaa'),
      ev('push.failed', 3, { version: 3, reason: 'NetworkError:Error' }, 'bbbbbbbbbbbb'),
      ev('pass.updated', 1, { version: 3 }),
    ]);
    expect(rows[0]?.facts.map((f) => f.text)).toContain('2 pushes failed: Could not reach Apple');
  });

  it('titles an unregistered device Stopped updates and falls back to a humanized kind', () => {
    expect(groupEvents([ev('device.unregistered', 1, {}, 'aaaaaaaaaaaa')])[0]?.title).toBe(
      'Stopped updates',
    );
    expect(eventLabel(ev('device.log', 1))).toBe('Wallet log line');
  });
});

describe('notified and silenced', () => {
  it('flags a version that notified or went silent over budget', () => {
    const told = groupEvents([ev('pass.updated', 1, { version: 2, notified: true })]);
    expect(told[0]?.facts).toContainEqual({ text: 'Notified', tone: 'info' });
    const silent = groupEvents([
      ev('pass.updated', 1, { version: 2, notified: false, overBudget: true }),
    ]);
    expect(silent[0]?.facts).toContainEqual({
      text: 'Silent: daily limit reached',
      tone: 'warning',
    });
  });

  it('links a message row to its broadcast', () => {
    const rows = groupEvents([
      ev('message.applied', 1, { broadcastId: 'b1', notified: true, overBudget: false }),
    ]);
    expect(rows[0]?.broadcastId).toBe('b1');
    expect(rows[0]?.facts.map((f) => f.text)).toEqual(['Notified']);
  });
});

describe('push counts', () => {
  it('does not say no devices when a device fetched anyway', () => {
    const rows = groupEvents([
      ev('device.fetched', 5000, { step: 'file', version: 2, status: 200 }, 'aaaaaaaaaaaa'),
      ev('push.queued', 1000, { version: 2, devices: 0 }),
      ev('pass.updated', 900, { version: 2 }),
    ]);
    const facts = rows[0]?.facts.map((f) => f.text) ?? [];
    expect(facts).not.toContain('No devices registered');
    expect(facts).not.toContain('Push queued');
  });
});

describe('repeats', () => {
  it('folds consecutive opens into one row and keeps other kinds apart', () => {
    const rows = groupEvents([
      ev('page.opened', 50),
      ev('page.opened', 40),
      ev('page.opened', 30),
      ev('pass.downloaded', 20),
      ev('page.opened', 10),
    ]);
    expect(rows.map((r) => r.title)).toEqual([
      'Pass page opened 3 times',
      '.pkpass downloaded',
      'Pass page opened',
    ]);
    expect(rows[0]?.folded).toBe(true);
    expect(rows[0]?.at).toBe(50);
  });
});
