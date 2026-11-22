/** The confirm step's edits and the calls it makes: scope, name, bind, a Manager's PIN, retry and undo. */
import {
  type AssignCmd,
  type AssignEvent,
  type AssignState,
  asCmd,
  type BindBodyIn,
} from './assign-state.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { put } from './reduce-assign.ts';
import type { Cmd } from './types.ts';

type Of<T extends AssignEvent['type']> = Extract<AssignEvent, { type: T }>;
const send = (cmd: AssignCmd): Cmd => asCmd(cmd);

export function edit(s: MachineState, ev: Of<'assign.scope'> | Of<'assign.label'>, env: Env): Out {
  const a = s.assign;
  if (a?.step !== 'confirm') return same(s);
  if (ev.type === 'assign.scope')
    return put(
      s,
      { ...a, scope: ev.scope === 'user' && !a.preview?.ownerAccount ? 'pass' : ev.scope },
      env,
    );
  return put(s, { ...a, label: ev.label.slice(0, 24) }, env);
}

function bindBody(
  a: AssignState,
  move: boolean,
  approval?: BindBodyIn['approval'],
): BindBodyIn | null {
  if (!a.tag || !a.card) return null;
  const label = a.label.trim();
  return {
    tag: a.tag.read,
    card: a.card,
    preview: false,
    binding: a.scope,
    ...(move ? { move: true } : {}),
    ...(label ? { label } : {}),
    ...(approval ? { approval } : {}),
  };
}

export function bind(s: MachineState, ev: Of<'assign.bind'>, env: Env): Out {
  const a = s.assign;
  if (a?.step !== 'confirm' || a.busy) return same(s);
  const body = bindBody(a, ev.move === true);
  if (!body) return same(s);
  const key = env.id();
  const cmd: AssignCmd = { c: 'assign.bind', key, body };
  return put(s, { ...a, key, busy: 'bind', retry: cmd, pin: null }, env, [send(cmd)]);
}

export function pin(s: MachineState, ev: Of<'assign.pin'>, env: Env): Out {
  const a = s.assign;
  if (a?.step !== 'confirm' && a?.step !== 'pass') return same(s);
  return put(s, { ...a, pin: ev.open ? { open: true, move: ev.move ?? false } : null }, env);
}

/** A Manager's PIN: the same bind again under a new key, with the approval. */
export function approve(s: MachineState, ev: Of<'assign.approve'>, env: Env): Out {
  const a = s.assign;
  const last = a?.retry;
  if (!a?.pin?.open || a.busy || last?.c !== 'assign.bind') return same(s);
  const key = env.id();
  const body: BindBodyIn = {
    ...last.body,
    ...(a.pin.move ? { move: true } : {}),
    approval: { ...(ev.staffId ? { staffId: ev.staffId } : {}), pin: ev.pin },
  };
  const { approval: _pin, ...kept } = body;
  // A pass picked by id asks for the PIN at the preview: the same preview again, with the approval.
  const busy = last.body.preview ? 'preview' : 'bind';
  return put(s, { ...a, key, busy, retry: { c: 'assign.bind', key, body: kept } }, env, [
    send({ c: 'assign.bind', key, body }),
  ]);
}

export function retry(s: MachineState, env: Env): Out {
  const a = s.assign;
  const last = a?.retry;
  if (!a || !last || a.busy || a.step !== 'error') return same(s);
  const key = env.id();
  const cmd = { ...last, key } as AssignCmd;
  const busy: AssignState['busy'] =
    last.c === 'assign.inspect'
      ? 'inspect'
      : last.c === 'enroll.complete'
        ? 'complete'
        : last.c === 'assign.bind' && last.body.preview
          ? 'preview'
          : 'bind';
  const step: AssignState['step'] =
    busy === 'bind' ? 'confirm' : busy === 'preview' ? 'pass' : 'tag';
  return put(s, { ...a, step, key, busy, error: null, retry: cmd }, env, [send(cmd)]);
}

export function undo(s: MachineState, env: Env): Out {
  const a = s.assign;
  const strip = s.assignStrip;
  const id = a?.result?.bindingId ?? strip?.bindingId;
  if (!id) return same(s);
  const key = env.id();
  const cmd = send({ c: 'assign.undo', key, bindingId: id });
  if (a) return put(s, { ...a, key, busy: 'undo' }, env, [cmd]);
  if (!strip) return same(s);
  return out({ ...s, assignStrip: { ...strip, undoKey: key } }, [cmd]);
}
