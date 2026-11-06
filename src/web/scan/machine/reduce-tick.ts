/** `tick`: runs every deadline that has passed, earliest first. */
import { deadlines } from './deadlines.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out } from './internal.ts';
import { expireUnsure, fail } from './reduce-answer.ts';
import { closeVerdict, settle, toReady } from './reduce-door.ts';
import { begin } from './reduce-read.ts';
import type { Cmd } from './types.ts';

const MAX_STEPS = 16;

function runOne(s: MachineState, kind: string, key: string | undefined, env: Env): Out {
  const { now } = env;
  const l = s.loop;
  switch (kind) {
    case 'card':
      if (s.card?.phase === 'rising')
        return out({ ...s, card: { ...s.card, phase: 'up' }, cardAt: now });
      return out({ ...s, card: null });
    case 'hint':
      return l.s === 'ready'
        ? out({ ...s, loop: { ...l, hint: Math.min(3, l.hint + 1) as 1 | 2 | 3 } })
        : out(s);
    case 'idle':
      if (l.s !== 'ready') return out(s);
      if (s.layout === 'stand') return out({ ...s, slowed: true }, [{ c: 'camera', op: 'slow' }]);
      return out({ ...s, loop: { s: 'paused', reason: 'idle' }, pausedAt: now }, [
        { c: 'camera', op: 'pause' },
      ]);
    case 'release':
      return out({ ...s, released: true }, [{ c: 'camera', op: 'stop' }]);
    case 'slow':
      if (l.s !== 'checking' && l.s !== 'applying') return out(s);
      return out({ ...s, loop: { ...l, slow: true } }, [{ c: 'sound', tone: 'read' }]);
    case 'timeout':
      if (l.s !== 'checking' && l.s !== 'applying') return out(s);
      return fail(s, { type: 'fail', key: l.key, error: 'timeout' }, env);
    case 'settle':
      return settle(s, env);
    case 'close':
      return closeVerdict(s, env);
    case 'open':
      return l.s === 'verdict' && l.next ? begin(s, l.next, env) : out(s);
    case 'clear': {
      if (l.s !== 'member') return out(s);
      const r = toReady(s, env);
      return r;
    }
    case 'unsure':
      return key ? expireUnsure(s, key) : out(s);
    default:
      return out(s);
  }
}

export function tick(s: MachineState, env: Env): Out {
  let state = s;
  const cmds: Cmd[] = [];
  for (let i = 0; i < MAX_STEPS; i++) {
    const due = deadlines(state, env.now)
      .filter((d) => d.at <= env.now)
      .sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    const next = runOne(state, due.kind, due.key, env);
    cmds.push(...next.cmds);
    state = next.state;
  }
  return out(state, cmds);
}
