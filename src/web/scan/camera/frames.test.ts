import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrames, createReadFilter, frameRegion } from './frames.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('camera frames', () => {
  it('requires two matching linear reads within 600ms and suppresses repeats', () => {
    const accept = createReadFilter();
    expect(accept('A', true, 0)).toBe(false);
    expect(accept('B', true, 100)).toBe(false);
    expect(accept('B', true, 800)).toBe(false);
    expect(accept('B', true, 900)).toBe(true);
    expect(accept('B', true, 1_000)).toBe(false);
    expect(accept('A', false, 1_100)).toBe(true);
    expect(accept('A', false, 1_200)).toBe(false);
    expect(accept('A', false, 2_600)).toBe(true);
  });
  it('includes every edge on every frame and caps resolution without a central crop', () => {
    expect(frameRegion(3840, 2160)).toEqual({
      x: 0,
      y: 0,
      w: 3840,
      h: 2160,
      width: 1280,
      height: 720,
    });
    expect(frameRegion(2160, 3840)).toEqual({
      x: 0,
      y: 0,
      w: 2160,
      h: 3840,
      width: 720,
      height: 1280,
    });
    expect(frameRegion(320, 240)).toEqual({ x: 0, y: 0, w: 320, h: 240, width: 320, height: 240 });
  });
  function setup() {
    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16) }) as ImageData),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    const video = { readyState: 2, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
    const decoder = {
      ready: vi.fn(() => true),
      available: vi.fn(() => true),
      close: vi.fn(),
      read: vi.fn(async () => ({ code: 'A', linear: false })),
    };
    const emit = vi.fn();
    const fail = vi.fn();
    const live = vi.fn();
    const frames = createFrames(
      () => video,
      decoder,
      () => ['qr'],
      emit,
      fail,
      live,
    );
    return { frames, decoder, emit, fail, live, ctx, video };
  }
  it('decodes pixels, pauses across overlays, and resumes without parallel loops', async () => {
    const t = setup();
    t.frames.resume();
    t.frames.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.ctx.drawImage).toHaveBeenCalledWith(t.video, 0, 0, 1280, 720, 0, 0, 1280, 720);
    expect(t.emit).toHaveBeenCalledWith({ method: 'camera', code: 'A' });
    expect(t.live).toHaveBeenCalledOnce();
    t.frames.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.decoder.read).toHaveBeenCalledOnce();
    t.frames.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.decoder.read).toHaveBeenCalledTimes(2);
    t.frames.slow();
    await vi.advanceTimersByTimeAsync(125);
    const n = t.decoder.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(249);
    expect(t.decoder.read).toHaveBeenCalledTimes(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.decoder.read).toHaveBeenCalledTimes(n + 1);
    t.frames.pause();
  });
  it('skips zero-sized frames and busy workers without throwing', async () => {
    const t = setup();
    Object.assign(t.video, { videoWidth: 0 });
    t.frames.resume();
    await vi.advanceTimersByTimeAsync(125);
    expect(t.ctx.drawImage).not.toHaveBeenCalled();
    Object.assign(t.video, { videoWidth: 1280 });
    t.decoder.available.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(125);
    expect(t.decoder.read).not.toHaveBeenCalled();
    t.frames.pause();
  });
  it('retries transient empty frames and classifies permanent capture errors', async () => {
    const t = setup();
    t.ctx.drawImage.mockImplementationOnce(() => {
      throw new DOMException('empty', 'InvalidStateError');
    });
    t.frames.resume();
    await vi.advanceTimersByTimeAsync(125);
    expect(t.emit).toHaveBeenCalledOnce();
    t.ctx.drawImage.mockImplementation(() => {
      throw new DOMException('capture denied', 'SecurityError');
    });
    await vi.advanceTimersByTimeAsync(125);
    expect(t.fail).toHaveBeenCalledOnce();
    t.frames.pause();
  });
  it('discards a frame decoded after pause', async () => {
    const t = setup();
    let resolve: ((v: { code: string; linear: boolean }) => void) | undefined;
    t.decoder.read.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    t.frames.resume();
    t.frames.pause();
    resolve?.({ code: 'late', linear: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.emit).not.toHaveBeenCalled();
  });
  it('fails if video never supplies a frame, instead of claiming it is live', async () => {
    const t = setup();
    Object.assign(t.video, { videoWidth: 0 });
    t.frames.resume();
    await vi.advanceTimersByTimeAsync(8_125);
    expect(t.live).not.toHaveBeenCalled();
    expect(t.fail).toHaveBeenCalledOnce();
    t.frames.pause();
  });
  it('classifies a missing canvas context as unavailable', () => {
    const t = setup();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const frames = createFrames(
      () => t.video,
      t.decoder,
      () => ['qr'],
      t.emit,
      t.fail,
      t.live,
    );
    frames.resume();
    expect(t.fail).toHaveBeenCalledOnce();
    expect(t.live).not.toHaveBeenCalled();
    frames.pause();
  });
});
