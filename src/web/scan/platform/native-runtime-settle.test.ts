import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanInput } from '../input/types.ts';
import { fixtureInput, fixtureOutcome, fixtureState } from '../machine/fixtures.test-support.ts';
import type { ScanState } from '../machine/types.ts';
import { createNativeRuntime } from './native-runtime.ts';

const posted: Record<string, unknown>[] = [];
const bridge = {
  postMessage: (s: string) => posted.push(JSON.parse(s)),
  onmessage: null as ((e: { data: string }) => void) | null,
};
const inp = (n: number): ScanInput =>
  fixtureInput({ id: `i-n${n}`, sig: `c:n${n}`, code: `n${n}` });
const loopState = (loop: Record<string, unknown>): ScanState =>
  fixtureState({ loop: loop as never });
const checking = (n: number, next?: number) =>
  loopState({
    s: 'checking',
    input: inp(n),
    key: `i-n${n}`,
    since: 0,
    slow: false,
    next: next ? inp(next) : null,
  });
const verdict = (n: number, kind: 'ok' | 'refused' | 'system' = 'ok', next?: number) =>
  loopState({
    s: 'verdict',
    input: inp(n),
    card: null,
    outcome: fixtureOutcome(kind),
    since: 0,
    closeAt: null,
    settleAt: null,
    openFrom: 0,
    next: next ? inp(next) : null,
  });
const member = (n: number, band: ScanState['loop'] | null = null) =>
  loopState({
    s: 'member',
    input: inp(n),
    card: {},
    since: 0,
    band: band ? fixtureOutcome(band as never) : null,
    picker: null,
    held: null,
    locked: false,
    key: `i-n${n}`,
  });
const ready = () => fixtureState();

function harness(features = ['scanAck', 'scanSettle']) {
  let state: ScanState = ready();
  let current = '';
  let reduce: (read: unknown) => ScanState = () => state;
  const rt = createNativeRuntime({
    session: () => ({ event: null, scanner: null }) as never,
    dispatch: (read) => {
      const { code } = read as { code: string };
      const input = fixtureInput({ id: `i-${current}`, sig: `c:${code}`, code });
      const before = state;
      const next = reduce(read);
      state = next;
      if (next !== before) rt.sync(next);
      return input;
    },
    now: () => 0,
    held: () => false,
    idle: () => false,
    notice: vi.fn(),
    snapshot: () => ({ state }),
    nfcReader: () => false,
    syncCameraMode: vi.fn(),
    tagEnded: new Set(),
    fail: vi.fn(),
  });
  bridge.onmessage?.({
    data: JSON.stringify({ version: 2, event: 'ready', features, capabilities: {} }),
  });
  posted.length = 0;
  return {
    rt,
    publish(s: ScanState) {
      state = s;
      rt.sync(s);
    },
    /** What the next scan does to the machine, run inside the read like the store does. */
    onRead(f: (read: unknown) => ScanState) {
      reduce = f;
    },
    scan: (id: string, value = id) => {
      current = id;
      bridge.onmessage?.({
        data: JSON.stringify({ version: 2, event: 'scan', id, source: 'barcode', value }),
      });
    },
  };
}
const ops = () => posted.filter((m) => m.op !== 'scanAck' && m.op !== 'customerStatus');

beforeEach(() => {
  posted.length = 0;
  bridge.onmessage = null;
  (globalThis as { PassBookNative?: unknown }).PassBookNative = bridge;
});

describe('native settle through the runtime', () => {
  it('a read in flight is answered when its verdict lands', () => {
    const h = harness();
    h.onRead(() => checking(1));
    h.scan('n1');
    expect(ops()).toEqual([]);
    h.publish(verdict(1));
    expect(ops()).toEqual([{ version: 2, op: 'result', id: 'n1', outcome: 'accepted' }]);
  });

  it('a verdict reached inside the read is answered right after track', () => {
    const h = harness();
    h.onRead(() => verdict(1, 'refused'));
    h.scan('n1');
    expect(ops()).toEqual([{ version: 2, op: 'result', id: 'n1', outcome: 'rejected' }]);
  });

  it('a duplicate of the read in flight is dropped as duplicate', () => {
    const h = harness();
    h.publish(checking(1));
    h.scan('n2', 'n1');
    expect(ops()).toEqual([{ version: 2, op: 'dropped', id: 'n2', reason: 'duplicate' }]);
  });

  it('a parked read gets its real result when it is promoted', () => {
    const h = harness();
    h.publish(checking(1));
    h.onRead(() => checking(1, 2));
    h.scan('n1');
    h.scan('n2');
    h.publish(verdict(1, 'ok', 2));
    h.publish(checking(2));
    h.publish(verdict(2, 'refused'));
    expect(ops()).toEqual([
      { version: 2, op: 'result', id: 'n1', outcome: 'accepted' },
      { version: 2, op: 'result', id: 'n2', outcome: 'rejected' },
    ]);
  });

  it('a read that left the next slot unpromoted is dropped as replaced', () => {
    const h = harness();
    h.onRead(() => checking(1, 2));
    h.scan('n2');
    h.publish(checking(1, 3));
    expect(ops()).toEqual([{ version: 2, op: 'dropped', id: 'n2', reason: 'replaced' }]);
  });

  it('a read that left with no verdict is dropped as closed', () => {
    const h = harness();
    h.onRead(() => checking(1));
    h.scan('n1');
    h.publish(ready());
    expect(ops()).toEqual([{ version: 2, op: 'dropped', id: 'n1', reason: 'closed' }]);
  });

  it('answers the on-screen read before the diff, and the diff sees the promotion', () => {
    const h = harness();
    h.onRead(() => checking(1, 2));
    h.scan('n1');
    h.publish(checking(1, 2));
    h.onRead(() => checking(1, 2));
    h.scan('n2');
    posted.length = 0;
    h.publish(verdict(2));
    expect(ops()).toEqual([
      { version: 2, op: 'result', id: 'n2', outcome: 'accepted' },
      { version: 2, op: 'dropped', id: 'n1', reason: 'closed' },
    ]);
  });

  it('revises a changed verdict once, and never after a drop', () => {
    const h = harness();
    h.onRead(() => verdict(1, 'system'));
    h.scan('n1');
    h.publish(verdict(1, 'ok'));
    h.publish(verdict(1, 'ok'));
    expect(ops()).toEqual([
      { version: 2, op: 'result', id: 'n1', outcome: 'error' },
      { version: 2, op: 'revise', id: 'n1', outcome: 'accepted' },
    ]);
    h.onRead(() => checking(2));
    h.scan('n2');
    h.publish(ready());
    posted.length = 0;
    h.publish(verdict(2));
    expect(ops()).toEqual([]);
  });

  it('a desk card answers accepted on entry and revises from its band', () => {
    const h = harness();
    h.onRead(() => member(1));
    h.scan('n1');
    h.publish(member(1, 'refused' as never));
    h.publish(member(1, 'refused' as never));
    h.publish(ready());
    expect(ops()).toEqual([
      { version: 2, op: 'result', id: 'n1', outcome: 'accepted' },
      { version: 2, op: 'revise', id: 'n1', outcome: 'rejected' },
    ]);
  });

  it('without scanSettle a drop is result error and nothing is revised', () => {
    const h = harness(['scanAck']);
    h.publish(checking(1));
    h.scan('n2', 'n1');
    expect(ops()).toEqual([{ version: 2, op: 'result', id: 'n2', outcome: 'error' }]);
    h.onRead(() => verdict(3, 'system'));
    h.scan('n3');
    h.publish(verdict(3, 'ok'));
    expect(ops().map((m) => m.op)).toEqual(['result', 'result']);
  });

  it('a new ready clears what was tracked', () => {
    const h = harness();
    h.onRead(() => checking(1));
    h.scan('n1');
    bridge.onmessage?.({
      data: JSON.stringify({ version: 2, event: 'ready', features: ['scanAck', 'scanSettle'] }),
    });
    h.publish(ready());
    expect(ops()).toEqual([]);
  });
});
