import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { sessionFixture } from '../boot/session.test-support.ts';
import { fixtureCounts } from '../machine/fixtures.test-support.ts';
import { clearNativeCapabilities, setNativeCapabilities } from './native-capabilities.ts';
import { createRuntime, type ScanRuntime } from './runtime.ts';

const ports = vi.hoisted(() => ({
  camera: { start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), slow: vi.fn() },
  native: {
    start: vi.fn(),
    stop: vi.fn(),
    result: vi.fn(),
    dispose: vi.fn(),
    capabilities: undefined as ((value: Record<string, unknown>) => void) | undefined,
  },
}));
vi.mock('../camera/controller.ts', () => ({ createCamera: () => ports.camera }));
vi.mock('../input/native-reader.ts', () => ({
  connectNativeReader: (options: { capabilities?: (value: Record<string, unknown>) => void }) => {
    ports.native.capabilities = options.capabilities;
    return ports.native;
  },
}));
vi.mock('../offline/db.ts', () => ({
  openScanDb: () => Promise.reject(new Error('Storage unavailable')),
}));
vi.mock('../sound/player.ts', () => ({
  sound: {
    enabled: () => false,
    unlock: vi.fn(),
    play: vi.fn(),
    cut: vi.fn(),
    setEnabled: vi.fn(),
  },
}));

let runtime: ScanRuntime | undefined;
afterEach(() => {
  runtime?.dispose();
  runtime = undefined;
  clearNativeCapabilities();
  ports.native.capabilities = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
function session(surface: 'phone' | 'operator', flow: 'auto' | 'choose' = 'auto'): ScanSession {
  const base = sessionFixture();
  return {
    ...base,
    scanner: { ...base.scanner!, settings: { ...base.scanner!.settings, flow } },
    workspace: {
      session: managedSession,
      device: { ...managedSession.devices[0]!, effectiveSurface: surface },
    },
  };
}
async function start(surface: 'phone' | 'operator') {
  const api = { stats: vi.fn().mockResolvedValue(fixtureCounts()) } as unknown as ScanApi;
  const announce = vi.fn();
  runtime = await createRuntime(session(surface), api, () => null, announce);
  runtime.start();
  return { runtime, announce };
}
describe('live scanner runtime configuration', () => {
  it('starts an Operator device without opening a camera and updates it without another Start', async () => {
    const { runtime, announce } = await start('operator');
    expect(runtime.store.getSnapshot().state).toMatchObject({ started: true, camera: 'disabled' });
    expect(ports.camera.start).not.toHaveBeenCalled();
    expect(ports.native.start).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Storage unavailable') }),
    );
    runtime.update(session('operator', 'choose'));
    expect(runtime.store.getSnapshot().state).toMatchObject({
      started: true,
      posture: 'desk',
      camera: 'disabled',
    });
    runtime.update(session('phone'));
    expect(ports.camera.start).toHaveBeenCalledOnce();
    expect(runtime.store.getSnapshot().state.started).toBe(true);
    runtime.update(session('operator'));
    expect(runtime.store.getSnapshot().state.camera).toBe('disabled');
    expect(ports.camera.stop).toHaveBeenCalled();
    await runtime.clear();
  });
  it('defers changes during a lookup and applies them when the operator is ready', async () => {
    const { runtime } = await start('phone');
    runtime.store.dispatch({ type: 'overlay', open: 'lookup' });
    runtime.update(session('operator', 'choose'));
    expect(runtime.store.getSnapshot().state.posture).toBe('door');
    runtime.store.dispatch({ type: 'overlay', open: null });
    expect(runtime.store.getSnapshot().state).toMatchObject({
      started: true,
      posture: 'desk',
      camera: 'disabled',
    });
    window.dispatchEvent(new Event('offline'));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ports.native.stop).toHaveBeenCalled();
    expect(ports.camera.stop).toHaveBeenCalled();
  });
  it('uses the camera instead of an unavailable Wallet VAS reader on an unfolded Duo', async () => {
    const base = session('operator');
    const duo = {
      ...base,
      scanner: {
        ...base.scanner!,
        settings: { ...base.scanner!.settings, reader: 'nfc' as const },
      },
    };
    const native = {
      ...managedSession.devices[0]!.capabilities!.native!,
      layout: { posture: 'unfolded' as const, division: null },
    };
    setNativeCapabilities(native);
    const api = { stats: vi.fn().mockResolvedValue(fixtureCounts()) } as unknown as ScanApi;
    const announce = vi.fn();
    runtime = await createRuntime(duo, api, () => null, announce);
    runtime.start();
    ports.native.capabilities?.(JSON.parse(JSON.stringify(native)));
    expect(runtime.store.getSnapshot().state.camera).not.toBe('disabled');
    expect(ports.camera.start).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Wallet pass reading is unavailable. Scan the barcode.',
        polite: false,
      }),
    );
  });
});
