import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureInput } from '../machine/fixtures.test-support.ts';
import { buzz } from './haptics.ts';
import { createNativeRuntime } from './native-runtime.ts';

const posted: Record<string, unknown>[] = [];
const bridge = {
  postMessage: (s: string) => posted.push(JSON.parse(s)),
  onmessage: null as ((e: { data: string }) => void) | null,
};

function runtime() {
  return createNativeRuntime({
    session: () => ({ event: null, scanner: null }) as never,
    dispatch: () => fixtureInput(),
    now: () => 0,
    held: () => false,
    idle: () => false,
    notice: vi.fn(),
    snapshot: () => ({ state: { started: true, block: null, loop: { s: 'ready' } } }) as never,
    nfcReader: () => false,
    syncCameraMode: vi.fn(),
    tagEnded: new Set(),
    fail: vi.fn(),
  });
}
const ready = (features: string[]) =>
  bridge.onmessage?.({
    data: JSON.stringify({ version: 2, event: 'ready', features, capabilities: {} }),
  });

beforeEach(() => {
  posted.length = 0;
  bridge.onmessage = null;
  (globalThis as { PassBookNative?: unknown }).PassBookNative = bridge;
});

describe('native runtime haptics', () => {
  it('buzzes at v2 once the app lists scanAck and scanSettle', () => {
    const rt = runtime();
    ready(['scanAck', 'scanSettle']);
    expect(buzz('ok', bridge, undefined, false)).toBe(true);
    expect(posted.at(-1)).toMatchObject({ version: 2, op: 'haptic', pattern: [40] });
    rt.dispose();
  });

  it('does not send a v2 buzz to an app without scanSettle', () => {
    const rt = runtime();
    ready(['scanAck']);
    posted.length = 0;
    expect(buzz('ok', bridge, undefined, false)).toBe(false);
    expect(posted).toEqual([]);
    rt.dispose();
  });

  it('clears the sender on a new runtime and on dispose', () => {
    const first = runtime();
    ready(['scanAck', 'scanSettle']);
    const second = runtime();
    posted.length = 0;
    expect(buzz('ok', bridge, undefined, false)).toBe(false);
    ready(['scanAck', 'scanSettle']);
    second.dispose();
    expect(buzz('ok', bridge, undefined, false)).toBe(false);
    first.dispose();
  });
});
