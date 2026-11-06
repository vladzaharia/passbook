/** Helpers for reducer tests: a fake id counter, a step function and input builders. */
import type { ScanInput } from '../input/types.ts';
import { FIXTURE_NOW, fixtureInput, fixtureOutcome } from './fixture-data.test-support.ts';
import { reduce } from './reduce.ts';
import type { Cmd, ReduceResult, ScanEvent, ScanOutcome, ScanState } from './types.ts';

export { FIXTURE_NOW };

let counter = 0;
export const resetIds = () => {
  counter = 0;
};
/** UUIDv7-shaped, strictly increasing. */
export const nextId = () => `01900000-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

export const at = (ms: number) => FIXTURE_NOW + ms;

export function step(state: ScanState, event: ScanEvent, now = FIXTURE_NOW): ReduceResult {
  return reduce(state, event, { now, id: nextId });
}

/** Runs events in order, each at its own time; returns the last result and every command emitted. */
export function play(
  state: ScanState,
  events: ReadonlyArray<readonly [number, ScanEvent]>,
): ReduceResult & { all: Cmd[] } {
  let current = state;
  const all: Cmd[] = [];
  let last: ReduceResult = { state, cmds: [] };
  for (const [ms, event] of events) {
    last = step(current, event, at(ms));
    current = last.state;
    all.push(...last.cmds);
  }
  return { ...last, all };
}

/** A read of `code` from the camera, stamped like the bus does. */
export function readOf(code: string, over: Partial<ScanInput> = {}, ms = 0): ScanEvent {
  return {
    type: 'read',
    input: fixtureInput({
      code,
      sig: `c:${code}`,
      id: nextId(),
      at: at(ms),
      ...over,
    }),
  };
}

export const cmdsOf = (cmds: Cmd[], c: Cmd['c']) => cmds.filter((cmd) => cmd.c === c);
export const hasCmd = (cmds: Cmd[], c: Cmd['c']) => cmds.some((cmd) => cmd.c === c);

/** The `key` the machine put on its request command. */
export function requestKey(cmds: Cmd[]): string {
  const req = cmds.find((cmd) => cmd.c === 'resolve' || cmd.c === 'act');
  if (!req || !('key' in req)) throw new Error('no request command');
  return req.key;
}

export const answerOf = (
  key: string,
  kind: ScanOutcome['kind'] = 'ok',
  reason: ScanOutcome['reason'] = null,
  over: Partial<ScanOutcome> = {},
): ScanEvent => ({ type: 'answer', key, outcome: fixtureOutcome(kind, reason, over) });
