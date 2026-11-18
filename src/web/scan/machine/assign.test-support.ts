/** Builders for the assign loop's tests: tag reads, card reads, API answers, and the key of a command. */
import type { BindResult, InspectResult, TagEnrollment, TagRead } from '../assign/types.ts';
import { tagSignature } from '../input/normalize.ts';
import type { AssignCmd } from './assign-state.ts';
import { fixtureInput } from './fixture-data.test-support.ts';
import { at, nextId, step } from './reduce.test-support.ts';
import type { Cmd, ScanEvent, ScanState } from './types.ts';

export const tagOf = (uid = '04a2b3c4d5e6f7', over: Partial<TagRead> = {}): TagRead => ({
  uid,
  tech: 'a',
  source: 'native',
  ...over,
});

export const tagReadEvent = (tag: TagRead = tagOf(), ms = 0): ScanEvent => ({
  type: 'read',
  input: fixtureInput({ method: 'nfc', tag, sig: tagSignature(tag), id: nextId(), at: at(ms) }),
});

export const cardReadEvent = (code = 'CARD-0001', ms = 0): ScanEvent => ({
  type: 'read',
  input: fixtureInput({ code, method: 'camera', sig: `c:${code}`, id: nextId(), at: at(ms) }),
});

export const inspectOf = (over: Partial<InspectResult> = {}): InspectResult => ({
  state: 'new',
  hint: 'F7A1',
  assurance: 'basic',
  bound: null,
  lostAt: null,
  boundAt: null,
  boundByName: null,
  ...over,
});

export const bindResultOf = (over: Partial<BindResult> = {}): BindResult => ({
  status: 'preview',
  hint: 'F7A1',
  assurance: 'basic',
  scope: 'pass',
  bindingId: null,
  card: {
    passId: '01900000-0000-7000-8000-0000000000aa',
    title: 'Gym membership',
    subtitle: null,
    templateName: 'Gym',
    holderName: 'Maya Okafor',
    photoUrl: null,
  },
  ownerAccount: true,
  skipped: [],
  warnings: [],
  lostAt: null,
  undoUntil: null,
  ...over,
});

export const enrollmentOf = (over: Partial<TagEnrollment> = {}): TagEnrollment => ({
  id: '01900000-0000-7000-8000-0000000000bb',
  holderName: 'Maya Okafor',
  passTitle: 'Gym membership',
  scope: 'pass',
  requestedByName: 'Ana R.',
  expiresAt: at(90_000),
  ...over,
});

export const assignCmd = <C extends AssignCmd['c']>(
  cmds: Cmd[],
  c: C,
): Extract<AssignCmd, { c: C }> => {
  const found = cmds.find((cmd) => (cmd as { c: string }).c === c);
  if (!found) throw new Error(`no ${c} command`);
  return found as unknown as Extract<AssignCmd, { c: C }>;
};

/** Plays events with a running state; `ms` is when each happens. */
export function run(state: ScanState, ...events: Array<[number, Parameters<typeof step>[1]]>) {
  let current = state;
  const log: Cmd[] = [];
  for (const [ms, ev] of events) {
    const r = step(current, ev, at(ms));
    current = r.state;
    log.push(...r.cmds);
  }
  return { state: current, cmds: log };
}
