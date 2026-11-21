import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEDGE_SCAN_EVENT } from '../input/wedge-source.ts';
import { initialState } from '../machine/initial-state.ts';
import type { ScanState } from '../machine/types.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { MonitorHardware, ScanHardware } from './hardware-control.tsx';

const cams = [
  { kind: 'videoinput', deviceId: 'b', label: 'Back Camera', groupId: '' },
  { kind: 'videoinput', deviceId: 'f', label: 'Front Camera', groupId: '' },
];

function stubBrowser({
  camera = 'granted',
  serial,
}: {
  camera?: string;
  serial?: { getPorts: () => Promise<never[]>; requestPort: () => Promise<never> };
} = {}) {
  const define = (key: string, value: unknown) =>
    Object.defineProperty(navigator, key, { configurable: true, value });
  define('mediaDevices', { enumerateDevices: async () => cams, getUserMedia: vi.fn() });
  define('permissions', { query: async () => ({ state: camera }) });
  define('serial', serial);
  vi.stubGlobal('NDEFReader', class {});
}

function runtimeStub(): ScanRuntime & {
  arm: ReturnType<typeof vi.fn>;
  hold: ReturnType<typeof vi.fn>;
} {
  const arm = vi.fn(async () => 'on' as const);
  return {
    arm,
    webNfc: { status: () => 'idle', arm, supported: true },
    camera: { hasWide: () => false, start: vi.fn(), choose: vi.fn() },
    emit: vi.fn(),
    hold: vi.fn(),
  } as unknown as ScanRuntime & { arm: ReturnType<typeof vi.fn>; hold: ReturnType<typeof vi.fn> };
}

const state = (over: Partial<ScanState> = {}): ScanState => ({
  ...initialState(Date.now()),
  started: true,
  camera: 'live',
  ...over,
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ['mediaDevices', 'permissions', 'serial'])
    Reflect.deleteProperty(navigator, key);
});

const pill = () => screen.getByTestId('hardware-pill');

describe('scanner hardware pill and panel', () => {
  it('shows the detected camera and opens the panel with how to scan', async () => {
    stubBrowser();
    const setChoice = vi.fn();
    const runtime = runtimeStub();
    render(<ScanHardware runtime={runtime} s={state()} lens={['back', setChoice]} camera />);
    await waitFor(() => expect(pill()).toHaveAccessibleName(/Camera/));
    fireEvent.click(pill());
    const dialog = await screen.findByRole('dialog', { name: 'Hardware' });
    expect(within(dialog).getByTestId('hardware-guide')).toHaveTextContent(
      'Point the back camera at the code',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use Front Camera' }));
    expect(setChoice).toHaveBeenCalledWith('front');
    expect(runtime.camera.choose).toHaveBeenCalledWith('front');
  });

  it('asks for a blocked camera only from the Allow tap', async () => {
    stubBrowser({ camera: 'denied' });
    const runtime = runtimeStub();
    render(
      <ScanHardware
        runtime={runtime}
        s={state({ camera: 'blocked' })}
        lens={['back', vi.fn()]}
        camera
      />,
    );
    await waitFor(() => expect(pill()).toHaveAccessibleName(/Camera needs access/));
    expect(runtime.camera.start).not.toHaveBeenCalled();
    fireEvent.click(pill());
    fireEvent.click(await screen.findByRole('button', { name: /^Allow/ }));
    expect(runtime.camera.start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('hardware-guide')).not.toHaveTextContent('camera');
  });

  it('starts Web NFC from a tap and says so', async () => {
    stubBrowser();
    const runtime = runtimeStub();
    render(<ScanHardware runtime={runtime} s={state()} lens={['back', vi.fn()]} camera />);
    fireEvent.click(pill());
    fireEvent.click(await screen.findByRole('button', { name: 'Start NFC' }));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
    // The open sheet hides the page from the tree: read the label itself.
    await waitFor(() => expect(pill().getAttribute('aria-label')).toMatch(/NFC on/));
  });

  it('adds the scanner on its first read and announces it', async () => {
    stubBrowser();
    render(<ScanHardware runtime={runtimeStub()} s={state()} lens={['back', vi.fn()]} camera />);
    await waitFor(() => expect(pill()).toHaveAccessibleName(/Camera/));
    expect(pill()).not.toHaveAccessibleName(/Scanner/);
    act(() => {
      window.dispatchEvent(new Event(WEDGE_SCAN_EVENT));
    });
    await waitFor(() => expect(pill()).toHaveAccessibleName(/Scanner on/));
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((s) => s.textContent === 'Scanner connected')).toBe(
        true,
      ),
    );
  });

  it('opens the serial picker only from Connect', async () => {
    const requestPort = vi.fn(() => Promise.reject(new DOMException('', 'NotFoundError')));
    stubBrowser({ serial: { getPorts: async () => [], requestPort: requestPort as never } });
    render(<ScanHardware runtime={runtimeStub()} s={state()} lens={['back', vi.fn()]} camera />);
    fireEvent.click(pill());
    await screen.findByRole('dialog');
    expect(requestPort).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Serial' }));
    expect(requestPort).toHaveBeenCalledTimes(1);
  });

  it('opens a scanner test that checks nothing in', async () => {
    stubBrowser();
    const runtime = runtimeStub();
    render(<ScanHardware runtime={runtime} s={state()} lens={['back', vi.fn()]} camera />);
    fireEvent.click(pill());
    fireEvent.click(await screen.findByRole('button', { name: 'Test Scanner' }));
    const box = screen.getByRole('textbox', { name: 'Test scan' });
    expect(box).toHaveFocus();
    fireEvent.keyDown(box, { key: 'A', code: 'KeyA' });
    expect(runtime.emit).not.toHaveBeenCalled();
    expect(runtime.hold).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(runtime.hold).toHaveBeenLastCalledWith(false);
  });

  it('shows a serial read in the test, not at check-in', async () => {
    const serial = Object.assign(new EventTarget(), {
      getPorts: async () => [] as unknown[],
      requestPort: vi.fn(),
    });
    stubBrowser({ serial: serial as never });
    const runtime = runtimeStub();
    render(<ScanHardware runtime={runtime} s={state()} lens={['back', vi.fn()]} camera />);
    fireEvent.click(pill());
    fireEvent.click(await screen.findByRole('button', { name: 'Test Scanner' }));
    const bytes = new TextEncoder().encode('SER-9\n');
    const port = {
      readable: null as ReadableStream<Uint8Array> | null,
      async open() {
        port.readable = new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        });
      },
      close: async () => undefined,
    };
    serial.getPorts = async () => [port];
    act(() => {
      serial.dispatchEvent(new Event('connect'));
    });
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Test scan' })).toHaveTextContent('SER-9'),
    );
    expect(runtime.emit).not.toHaveBeenCalled();
  });
});

describe('monitor hardware', () => {
  it('lists the device without scanning steps or actions', async () => {
    stubBrowser();
    render(<MonitorHardware online />);
    fireEvent.click(pill());
    const dialog = await screen.findByRole('dialog', { name: 'Hardware' });
    expect(within(dialog).queryByTestId('hardware-guide')).toBeNull();
    await waitFor(() => expect(within(dialog).getByTestId('hw-camera:0')).toBeVisible());
    expect(within(dialog).queryByRole('button', { name: /^(Allow|Use|Start|Test)/ })).toBeNull();
  });
});
