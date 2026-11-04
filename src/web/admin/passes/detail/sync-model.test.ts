import { describe, expect, it } from 'vitest';
import type { PassEventDto } from '@/shared/contracts/events.ts';
import { duration, groupEvents } from './sync-model.ts';

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
    expect(rows.map((r) => r.title)).toEqual(['Device removed the pass', 'Updated to v7']);
    const group = rows[1];
    expect(group?.group).toBe(true);
    expect(group?.facts.map((f) => f.text)).toEqual(['Pushed to 2 devices', '1 fetched in 13 s']);
    expect(group?.tone).toBe('success');
    // The check-in belongs to the version; a device leaving does not.
    expect(group?.events.map((e) => e.kind)).toContain('device.fetched');
    expect(group?.events.map((e) => e.kind)).not.toContain('device.unregistered');
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
    expect(failed[0]?.facts.map((f) => f.text)).toContain('1 push failed: PayloadEmpty');
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
