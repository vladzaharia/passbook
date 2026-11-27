import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { sessionFixture } from '../boot/session.test-support.ts';
import type { RawRead } from '../input/types.ts';
import { fixtureCounts } from '../machine/fixtures.test-support.ts';
import { localOutcome } from '../machine/outcome.ts';
import { clearNativeCapabilities, setNativeCapabilities } from './native-capabilities.ts';
import { createRuntime, type ScanRuntime } from './runtime.ts';

const ports = vi.hoisted(() => ({
  camera: { start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), slow: vi.fn() },
  native: {
    start: vi.fn(),
    stop: vi.fn(),
    result: vi.fn(),
    customerStatus: vi.fn(),
    customerBranding: vi.fn(),
    dispose: vi.fn(),
    unanswered: vi.fn(() => [] as string[]),
    capabilities: undefined as ((value: Record<string, unknown>) => void) | undefined,
    read: undefined as ((read: RawRead) => unknown) | undefined,
  },
  cameraEmit: undefined as ((read: RawRead) => void) | undefined,
}));
vi.mock('../camera/controller.ts', () => ({
  createCamera: (_video: unknown, _formats: unknown, emit: (read: RawRead) => void) => {
    ports.cameraEmit = emit;
    return ports.camera;
  },
}));
vi.mock('../input/native-reader.ts', () => ({
  connectNativeReader: (options: {
    capabilities?: (value: Record<string, unknown>) => void;
    read: (read: RawRead) => unknown;
  }) => {
    ports.native.capabilities = options.capabilities;
    ports.native.read = options.read;
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
describe('hardware test hold', () => {
  it('keeps every source away from check-in while held', async () => {
    const api = {
      stats: vi.fn().mockResolvedValue(fixtureCounts()),
      resolve: vi.fn().mockResolvedValue(localOutcome('system', 'server', fixtureCounts())),
    } as unknown as ScanApi;
    runtime = await createRuntime(session('operator', 'choose'), api, () => null, vi.fn());
    runtime.start();
    runtime.hold(true);
    expect(runtime.emit({ method: 'wedge', code: 'SERIAL-1' })).toBeNull();
    expect(ports.native.read?.({ method: 'camera', code: 'NATIVE-1' })).toEqual({ error: true });
    ports.cameraEmit?.({ method: 'camera', code: 'CAM-1', format: 'qr' });
    const scanned = vi.fn();
    window.addEventListener('passbook:wedge-scan', scanned);
    for (const [key, code] of [...'ABCDE'].map((k) => [k, `Key${k}`]).concat([['Enter', 'Enter']]))
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
    window.removeEventListener('passbook:wedge-scan', scanned);
    expect(scanned).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(api.resolve).not.toHaveBeenCalled();
    runtime.hold(false);
    expect(runtime.emit({ method: 'wedge', code: 'SERIAL-2' })).toBeTruthy();
  });
});

describe('native reads the page cannot take', () => {
  it('says so instead of dropping a native read silently', async () => {
    const api = {
      stats: vi.fn().mockResolvedValue(fixtureCounts()),
      resolve: vi.fn().mockResolvedValue(localOutcome('system', 'server', fixtureCounts())),
    } as unknown as ScanApi;
    const announce = vi.fn();
    runtime = await createRuntime(session('operator', 'choose'), api, () => null, announce);
    expect(ports.native.read?.({ method: 'wedge', code: 'EARLY-1' })).toEqual({ error: true });
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Not scanning right now. Resume, then scan again.' }),
    );
  });
});

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

  it('projects web camera and manual scan states as generic customer-display statuses', async () => {
    const base = {
      ...session('operator', 'choose'),
      branding: {
        accent: '#0f766e',
        logo: { sha: 'a'.repeat(64), w: 480, h: 150 },
      },
    };
    const accepted = {
      ...localOutcome('system', 'server', fixtureCounts()),
      kind: 'ok' as const,
      local: false,
    };
    const api = {
      stats: vi.fn().mockResolvedValue(fixtureCounts()),
      resolve: vi.fn().mockResolvedValue(accepted),
    } as unknown as ScanApi;
    runtime = await createRuntime(base, api, () => null, vi.fn());
    expect(ports.native.customerBranding).toHaveBeenCalledWith({
      name: 'Henry',
      accent: '#0f766e',
      logoSha: 'a'.repeat(64),
    });
    runtime.start();

    const inputId = runtime.emit({ method: 'manual', code: '000123' });
    expect(inputId).toBeTruthy();
    expect(ports.native.customerStatus).toHaveBeenCalledWith('checking', inputId);

    await vi.waitFor(() => {
      expect(ports.native.result).toHaveBeenCalledWith(inputId, 'accepted');
      expect(ports.native.customerStatus).toHaveBeenCalledWith('accepted', inputId);
    });
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
    await setNativeCapabilities(native);
    const api = { stats: vi.fn().mockResolvedValue(fixtureCounts()) } as unknown as ScanApi;
    const announce = vi.fn();
    runtime = await createRuntime(duo, api, () => null, announce);
    runtime.start();
    ports.native.capabilities?.(JSON.parse(JSON.stringify(native)));
    await vi.waitFor(() =>
      expect(announce).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Wallet pass verification is unavailable. Scan the barcode.',
          polite: false,
        }),
      ),
    );
    expect(runtime.store.getSnapshot().state.camera).not.toBe('disabled');
    expect(ports.camera.start).toHaveBeenCalled();
  });
  it('keeps the iOS camera active when no native barcode reader is available', async () => {
    const base = session('phone');
    const barcode = {
      ...base,
      scanner: {
        ...base.scanner!,
        settings: { ...base.scanner!.settings, reader: 'barcode' as const },
      },
    };
    await setNativeCapabilities(managedSession.devices[0]!.capabilities!.native);
    const api = { stats: vi.fn().mockResolvedValue(fixtureCounts()) } as unknown as ScanApi;
    runtime = await createRuntime(barcode, api, () => null, vi.fn());
    runtime.start();
    expect(runtime.store.getSnapshot().state.camera).not.toBe('disabled');
    expect(ports.camera.start).toHaveBeenCalled();
  });
});
