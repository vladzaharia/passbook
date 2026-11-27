import { describe, expect, it, vi } from 'vitest';
import { connectNativeReader } from './native-reader.ts';

function setup() {
  const sent: Record<string, unknown>[] = [];
  const bridge = {
    postMessage: (s: string) => sent.push(JSON.parse(s)),
    onmessage: null as ((e: { data: string }) => void) | null,
  };
  const settleReady = vi.fn();
  const client = connectNativeReader(
    { read: () => ({ error: true }), cancelled: vi.fn(), unsupported: vi.fn(), settleReady },
    bridge,
  );
  const ready = (version: 1 | 2, features?: string[]) =>
    bridge.onmessage?.({
      data: JSON.stringify({
        version,
        event: 'ready',
        ...(features ? { features } : {}),
        capabilities: {},
      }),
    });
  return { sent, settleReady, client, ready };
}

describe('native reader haptics', () => {
  it('sends the buzz at v1 before a v2 ready and at v2 after it', () => {
    const s = setup();
    s.client?.haptic([40]);
    expect(s.sent.at(-1)).toEqual({ version: 1, op: 'haptic', pattern: [40] });
    s.ready(2, ['scanAck', 'scanSettle']);
    s.client?.haptic([40, 70, 40]);
    expect(s.sent.at(-1)).toEqual({ version: 2, op: 'haptic', pattern: [40, 70, 40] });
  });

  it('reports the sender gate only with scanAck and scanSettle', () => {
    const s = setup();
    s.ready(2, ['scanAck', 'scanSettle']);
    expect(s.settleReady).toHaveBeenLastCalledWith(true);
    s.ready(2, ['scanAck']);
    expect(s.settleReady).toHaveBeenLastCalledWith(false);
    s.ready(2, ['scanSettle']);
    expect(s.settleReady).toHaveBeenLastCalledWith(false);
    s.ready(2);
    expect(s.settleReady).toHaveBeenLastCalledWith(false);
  });
});

describe('native reader haptics, v1 app', () => {
  it('never reports the gate for a v1 ready', () => {
    const s = setup();
    s.ready(1, ['scanAck', 'scanSettle']);
    expect(s.settleReady).toHaveBeenLastCalledWith(false);
  });
});
