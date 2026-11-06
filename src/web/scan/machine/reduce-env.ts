/** Environment events: start, resume, camera, visibility, focus, network, overlay, prefs, scope, counts. */
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import type { Cmd, ScanEvent } from './types.ts';

type Of<T extends ScanEvent['type']> = Extract<ScanEvent, { type: T }>;

/** The Start tap. Runs inside the click handler: audio needs the gesture. */
export function start(s: MachineState, env: Env): Out {
  const cmds: Cmd[] = [
    { c: 'audio', op: 'unlock' },
    { c: 'wake', op: 'request' },
  ];
  let camera = s.camera;
  if (s.camera !== 'disabled') {
    cmds.push({ c: 'camera', op: 'start' });
    camera = 'starting';
  }
  return out(
    {
      ...s,
      started: true,
      camera,
      loop: s.loop.s === 'ready' ? { s: 'ready', since: env.now, hint: 0 } : s.loop,
      lastActivity: env.now,
      slowed: false,
    },
    cmds,
  );
}

export function resume(s: MachineState, env: Env): Out {
  if (s.loop.s !== 'paused') return same(s);
  const restart = s.released || s.camera === 'off';
  return out(
    {
      ...s,
      loop: { s: 'ready', since: env.now, hint: 0 },
      released: false,
      pausedAt: undefined,
      pausedReason: undefined,
      lastActivity: env.now,
      slowed: false,
    },
    [
      { c: 'wake', op: 'request' },
      { c: 'audio', op: 'unlock' },
      { c: 'camera', op: restart ? 'start' : 'resume' },
    ],
  );
}

export function camera(s: MachineState, ev: Of<'camera'>, env: Env): Out {
  const cmds: Cmd[] = [];
  let loop = s.loop;
  if (ev.status === 'live' && loop.s === 'ready') loop = { s: 'ready', since: env.now, hint: 0 };
  if (
    (ev.status === 'blocked' || ev.status === 'unavailable' || ev.status === 'decoder_failed') &&
    loop.s === 'ready'
  )
    cmds.push({ c: 'focus', target: 'enter-code' });
  return out(
    { ...s, camera: ev.status, loop, released: ev.status === 'live' ? false : s.released },
    cmds,
  );
}

export function visible(s: MachineState, ev: Of<'visible'>, env: Env): Out {
  if (ev.visible || s.loop.s !== 'ready') return same(s);
  return out({ ...s, loop: { s: 'paused', reason: 'hidden' }, pausedAt: env.now }, [
    { c: 'camera', op: 'pause' },
    { c: 'beat', beat: 'cut' },
  ]);
}

/** The simple setters. */
export function setter(s: MachineState, ev: ScanEvent, env: Env): Out | null {
  switch (ev.type) {
    case 'scope':
      return out({ ...s, scope: { ...s.scope, ...ev.scope }, lastActivity: env.now });
    case 'focus':
      return out({ ...s, focused: ev.focused });
    case 'online':
      return out({ ...s, online: ev.online });
    case 'queue':
      return out({
        ...s,
        queue: { pending: ev.pending, oldestAt: ev.oldestAt, conflicts: ev.conflicts },
      });
    case 'overlay':
      return out({ ...s, overlay: ev.open, lastActivity: env.now });
    case 'prefs':
      return out({ ...s, prefs: { ...s.prefs, ...ev.prefs } });
    case 'counts':
      return out({ ...s, counts: ev.counts });
    case 'reader':
      return out({ ...s, reader: { ...s.reader, ...ev.reader } });
    default:
      return null;
  }
}
