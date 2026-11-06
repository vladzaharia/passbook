import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecoder } from './decoder.ts';
import type { CameraReply } from './protocol.ts';

class WorkerFake {
  static current: WorkerFake;
  onmessage: ((e: { data: CameraReply }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    WorkerFake.current = this;
  }
  reply(data: CameraReply) {
    this.onmessage?.({ data });
  }
}
const image = () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }) as ImageData;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', WorkerFake);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('camera decoder', () => {
  it('waits for WASM readiness and bounds work to one frame', async () => {
    const fail = vi.fn();
    const decoder = createDecoder(fail);
    const w = WorkerFake.current;
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'init' }, []);
    expect(decoder.available()).toBe(false);
    expect(await decoder.read(image(), ['qr'])).toBeNull();
    w.reply({ type: 'ready' });
    expect(decoder.ready()).toBe(true);
    const reading = decoder.read(image(), ['qr']);
    expect(decoder.available()).toBe(false);
    expect(await decoder.read(image(), ['qr'])).toBeNull();
    w.reply({ type: 'frame', id: 99, hit: null });
    expect(decoder.available()).toBe(false);
    w.reply({ type: 'frame', id: 1, hit: { code: 'A', linear: false } });
    expect(await reading).toEqual({ code: 'A', linear: false });
    expect(decoder.available()).toBe(true);
    decoder.close();
    expect(fail).not.toHaveBeenCalled();
    expect(decoder.ready()).toBe(false);
  });
  it('fails and terminates a stalled initialization', async () => {
    const fail = vi.fn();
    const decoder = createDecoder(fail);
    expect(decoder.ready()).toBe(false);
    const w = WorkerFake.current;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fail).toHaveBeenCalledOnce();
    expect(w.terminate).toHaveBeenCalledOnce();
    w.reply({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fail).toHaveBeenCalledOnce();
  });
  it('releases a stalled frame and ignores replies after termination', async () => {
    const fail = vi.fn();
    const d = createDecoder(fail);
    const w = WorkerFake.current;
    w.reply({ type: 'ready' });
    const reading = d.read(image(), ['code128']);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await reading).toBeNull();
    w.reply({ type: 'frame', id: 1, hit: { code: 'late', linear: true } });
    expect(d.available()).toBe(false);
    expect(fail).toHaveBeenCalledOnce();
  });
  it.each(['error', 'message', 'reply', 'post'] as const)(
    'classifies %s failure without a barcode',
    async (kind) => {
      const fail = vi.fn();
      const d = createDecoder(fail);
      const w = WorkerFake.current;
      w.reply({ type: 'ready' });
      if (kind === 'error') w.onerror?.();
      if (kind === 'message') w.onmessageerror?.();
      if (kind === 'reply') w.reply({ type: 'error' });
      if (kind === 'post') {
        w.postMessage.mockImplementation(() => {
          throw new DOMException('closed');
        });
        expect(await d.read(image(), ['qr'])).toBeNull();
      }
      expect(fail).toHaveBeenCalledOnce();
      expect(w.terminate).toHaveBeenCalledOnce();
    },
  );
  it('cancels initialization cleanly on stop', async () => {
    const fail = vi.fn();
    const d = createDecoder(fail);
    d.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fail).not.toHaveBeenCalled();
  });
});
