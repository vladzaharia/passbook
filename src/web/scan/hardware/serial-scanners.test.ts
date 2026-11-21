import { describe, expect, it, vi } from 'vitest';
import {
  createSerialScanners,
  linesOf,
  SERIAL_LINE_MAX,
  type SerialPortLike,
} from './serial-scanners.ts';

function port(chunks: string[]): SerialPortLike & { opened: boolean } {
  const bytes = chunks.map((c) => new TextEncoder().encode(c));
  const p = {
    opened: false,
    readable: null as ReadableStream<Uint8Array> | null,
    async open() {
      p.opened = true;
      p.readable = new ReadableStream({
        start(controller) {
          for (const b of bytes) controller.enqueue(b);
          controller.close();
        },
      });
    },
    close: vi.fn(async () => undefined),
  };
  return p;
}

describe('serial scanners', () => {
  it('splits lines on any line ending and keeps the rest', () => {
    expect(linesOf('ABC\r\nDEF\nGH')).toEqual({ codes: ['ABC', 'DEF'], rest: 'GH' });
    expect(linesOf('\r\n\r\n')).toEqual({ codes: [], rest: '' });
  });

  it('reopens granted ports without a prompt and emits each line', async () => {
    const p = port(['PASS-', '123\r', '\nPASS-456\n']);
    const requestPort = vi.fn();
    const emit = vi.fn();
    const changed = vi.fn();
    const s = createSerialScanners({ getPorts: async () => [p], requestPort }, emit, changed);
    await s.resume();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(emit.mock.calls).toEqual([['PASS-123'], ['PASS-456']]);
    expect(requestPort).not.toHaveBeenCalled();
    expect(p.opened).toBe(true);
    await vi.waitFor(() => expect(p.close).toHaveBeenCalled());
  });

  it('connects a new port from a tap, and reports a cancel', async () => {
    const p = port(['X1\n']);
    const emit = vi.fn();
    const ok = createSerialScanners(
      { getPorts: async () => [], requestPort: async () => p },
      emit,
      () => undefined,
    );
    expect(await ok.connect()).toBe(true);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('X1'));
    const cancelled = createSerialScanners(
      {
        getPorts: async () => [],
        requestPort: () => Promise.reject(new DOMException('', 'NotFoundError')),
      },
      emit,
      () => undefined,
    );
    expect(await cancelled.connect()).toBe(false);
    expect(createSerialScanners(undefined, emit, () => undefined).supported).toBe(false);
  });

  it('reads a re-plugged scanner again on connect', async () => {
    const serial = new EventTarget() as EventTarget & {
      getPorts: () => Promise<SerialPortLike[]>;
      requestPort: () => Promise<SerialPortLike>;
    };
    let current = port(['ONE\n']);
    serial.getPorts = async () => [current];
    serial.requestPort = vi.fn();
    const emit = vi.fn();
    const s = createSerialScanners(serial as never, emit, () => undefined);
    await s.resume();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('ONE'));
    await vi.waitFor(() => expect(current.close).toHaveBeenCalled());
    current = port(['TWO\n']);
    serial.dispatchEvent(new Event('connect'));
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('TWO'));
    s.stop();
    current = port(['THREE\n']);
    serial.dispatchEvent(new Event('connect'));
    await new Promise((r) => setTimeout(r, 10));
    expect(emit).not.toHaveBeenCalledWith('THREE');
  });

  it('drops a line that never ends past the cap', async () => {
    const p = port(['x'.repeat(SERIAL_LINE_MAX + 10), 'OK\n']);
    const emit = vi.fn();
    await createSerialScanners(
      { getPorts: async () => [p], requestPort: vi.fn() },
      emit,
      () => undefined,
    ).resume();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('OK'));
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
