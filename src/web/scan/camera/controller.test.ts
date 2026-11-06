import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCamera } from './controller.ts';

const mocks = vi.hoisted(() => ({
  frames: { pause: vi.fn(), resume: vi.fn(), slow: vi.fn() },
  decoder: { close: vi.fn() },
  createDecoder: vi.fn(),
  createFrames: vi.fn(),
}));
vi.mock('./decoder.ts', () => ({ createDecoder: mocks.createDecoder }));
vi.mock('./frames.ts', () => ({ createFrames: mocks.createFrames }));
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function setup() {
  const track = {
    readyState: 'live',
    stop: vi.fn(),
    onended: null as (() => void) | null,
    getCapabilities: vi.fn(() => ({ torch: true })),
    applyConstraints: vi.fn(async () => {}),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  const enumerateDevices = vi.fn(async () => [] as MediaDeviceInfo[]);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } });
  const video = { srcObject: null, play: vi.fn(async () => {}) } as unknown as HTMLVideoElement;
  const status = vi.fn();
  const emit = vi.fn();
  const camera = createCamera(
    () => video,
    () => ['qr'],
    emit,
    status,
  );
  return { camera, video, status, emit, getUserMedia, enumerateDevices, stream, track };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createDecoder.mockReturnValue(mocks.decoder);
  mocks.createFrames.mockImplementation((_v, _d, _f, _emit, _fail, live) => {
    live();
    return mocks.frames;
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('camera lifecycle', () => {
  it('starts and releases every camera resource, with torch and slow controls', async () => {
    const t = setup();
    t.camera.start();
    await flush();
    expect(t.status.mock.calls.flat()).toEqual(['starting', 'live']);
    expect(t.video.srcObject).toBe(t.stream);
    expect(t.camera.hasTorch()).toBe(true);
    expect(await t.camera.toggleTorch()).toBe(true);
    expect(t.track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    t.camera.pause();
    t.camera.resume();
    t.camera.slow();
    expect(mocks.frames.slow).toHaveBeenCalledOnce();
    t.camera.stop();
    expect(t.track.stop).toHaveBeenCalledOnce();
    expect(t.video.srcObject).toBeNull();
    expect(mocks.decoder.close).toHaveBeenCalledOnce();
    expect(await t.camera.toggleTorch()).toBe(false);
  });
  it('keeps a good stream when optional device enumeration fails', async () => {
    const t = setup();
    t.enumerateDevices.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    t.camera.start();
    await flush();
    expect(t.status).toHaveBeenLastCalledWith('live');
    expect(t.camera.hasWide()).toBe(false);
    expect(t.track.stop).not.toHaveBeenCalled();
    t.camera.stop();
  });
  it('falls back to any camera on unsupported constraints, preserving permission failures', async () => {
    const t = setup();
    t.getUserMedia.mockRejectedValueOnce(
      new DOMException('bad constraint', 'OverconstrainedError'),
    );
    t.camera.start();
    await flush();
    expect(t.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: true });
    expect(t.status).toHaveBeenLastCalledWith('live');
    t.camera.stop();
  });
  it.each(['NotAllowedError', 'SecurityError', 'NotFoundError'])(
    'classifies %s and permits a retry',
    async (name) => {
      const t = setup();
      t.getUserMedia.mockRejectedValueOnce(new DOMException('camera error', name));
      t.camera.start();
      await flush();
      expect(t.status).toHaveBeenLastCalledWith(
        name === 'NotFoundError' ? 'unavailable' : 'blocked',
      );
      expect(t.getUserMedia).toHaveBeenCalledOnce();
      t.camera.start();
      await flush();
      expect(t.status).toHaveBeenLastCalledWith('live');
      t.camera.stop();
    },
  );
  it('stops late permission grants after navigation instead of leaking the camera', async () => {
    const t = setup();
    let grant: ((s: MediaStream) => void) | undefined;
    t.getUserMedia.mockImplementation(
      () =>
        new Promise((r) => {
          grant = r;
        }),
    );
    t.camera.start();
    t.camera.stop();
    grant?.(t.stream);
    await flush();
    expect(t.track.stop).toHaveBeenCalledOnce();
    expect(mocks.createDecoder).not.toHaveBeenCalled();
  });
  it('releases a disconnected camera and can select the front camera to recover', async () => {
    const t = setup();
    t.camera.start();
    await flush();
    t.track.onended?.();
    expect(t.status).toHaveBeenLastCalledWith('unavailable');
    t.camera.choose('front');
    await flush();
    expect(t.getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 } },
    });
    expect(t.status).toHaveBeenLastCalledWith('live');
    t.camera.stop();
  });
  it('cleans up decoder initialization and playback failures', async () => {
    const t = setup();
    mocks.createDecoder.mockImplementationOnce(() => {
      throw new Error('Worker unavailable');
    });
    t.camera.start();
    await flush();
    expect(t.status).toHaveBeenLastCalledWith('decoder_failed');
    expect(t.track.stop).toHaveBeenCalledOnce();
    vi.mocked(t.video.play).mockRejectedValueOnce(new DOMException('no video', 'NotReadableError'));
    t.camera.start();
    await flush();
    expect(t.status).toHaveBeenLastCalledWith('unavailable');
  });
  it('survives unsupported capability queries and discovers a wide camera', async () => {
    const t = setup();
    t.enumerateDevices.mockResolvedValue([
      { kind: 'videoinput', deviceId: 'wide', label: 'Back ultra-wide' } as MediaDeviceInfo,
    ]);
    t.track.getCapabilities.mockImplementation(() => {
      throw new Error('Unsupported');
    });
    t.camera.start();
    await flush();
    expect(t.camera.hasTorch()).toBe(false);
    expect(t.camera.hasWide()).toBe(true);
    t.camera.choose('back-wide');
    await flush();
    expect(t.getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { deviceId: { exact: 'wide' }, width: { ideal: 1280 } },
    });
    t.camera.stop();
  });
  it('handles browsers without media devices and video elements that unmount', async () => {
    const t = setup();
    vi.stubGlobal('navigator', {});
    t.camera.start();
    await flush();
    expect(t.status).toHaveBeenLastCalledWith('unavailable');
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: t.getUserMedia } });
    const c = createCamera(
      () => null,
      () => ['qr'],
      t.emit,
      t.status,
    );
    c.start();
    await flush();
    expect(t.track.stop).toHaveBeenCalledOnce();
    expect(t.status).toHaveBeenLastCalledWith('unavailable');
  });
});
