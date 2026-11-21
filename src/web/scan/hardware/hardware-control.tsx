import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { savedCount } from '../machine/derive.ts';
import type { ScanState } from '../machine/types.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { LiveAnnouncer } from '../ui/live-announcer.tsx';
import type { CameraChoice } from '../ui/scan-menu.tsx';
import { panelRows } from './guide.ts';
import { HardwarePanel } from './hardware-panel.tsx';
import { HardwarePill } from './hardware-pill.tsx';
import { createSerialScanners, type SerialLike } from './serial-scanners.ts';
import type { TestRead } from './test-pad.tsx';
import type { HardwareAction, HardwareItem } from './types.ts';
import { type HardwareInputs, type HardwareView, useHardware } from './use-hardware.ts';

/** Asks for the camera from a tap, before Start: the labels then show, and the stream stops. */
async function askCamera(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // Refused or no camera: the row says so after the next enumeration.
  }
}

const SCAN_VIDEO = {
  get current() {
    return document.querySelector<HTMLVideoElement>('video.scan-video');
  },
};

/** The pill, its panel and the polite region that says what changed. */
function HardwareSurface({
  view,
  inputs,
  onAction,
  onTesting,
  testRead = null,
}: {
  view: HardwareView;
  inputs: Pick<HardwareInputs, 'reads' | 'camera'>;
  onAction?: (item: HardwareItem, action: HardwareAction) => void;
  /** The scanner test opened or closed: the scanner holds check-in while it is open. */
  onTesting?: (on: boolean) => void;
  /** A read the test took from a source other than the keyboard (a serial scanner). */
  testRead?: TestRead | null;
}) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const tell = useRef(onTesting);
  tell.current = onTesting;
  useEffect(() => tell.current?.(testing !== null), [testing]);
  const { refresh, change } = view;
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);
  const said = useMemo(() => (change ? { ...change, polite: true } : null), [change]);
  return (
    <>
      <HardwarePill icons={view.icons} reads={view.reads} onOpen={() => setOpen(true)} />
      <LiveAnnouncer message={said} />
      {open ? (
        <HardwarePanel
          items={panelRows(view.items, { reads: inputs.reads, camera: inputs.camera !== null })}
          testing={testing}
          testRead={testRead}
          onAction={(item, action) => {
            if (action.kind === 'test') setTesting(item.id);
            else onAction?.(item, action);
          }}
          onTestDone={() => setTesting(null)}
          onClose={() => {
            setTesting(null);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/** The scanner's hardware: door, handheld, desk and operator. Placed beside the menu. */
export function ScanHardware({
  runtime,
  s,
  video,
  lens,
  camera,
  readerUsable = false,
}: {
  runtime: ScanRuntime;
  s: ScanState;
  /** The scanner's one video element when absent. */
  video?: { current: HTMLVideoElement | null };
  lens: [CameraChoice, (choice: CameraChoice) => void];
  /** False where the view runs no camera (the operator desk). */
  camera: boolean;
  /** The session's built-in reader (barcode or Wallet), as the loop decides it. */
  readerUsable?: boolean;
}) {
  const [web, setWeb] = useState(runtime.webNfc.status());
  const inputs: HardwareInputs = {
    reads: true,
    focused: s.focused,
    readerUsable,
    camera: camera ? s.camera : null,
    cameraChoice: lens[0],
    hasWide: runtime.camera.hasWide(),
    started: s.started,
    online: s.online,
    queued: savedCount(s),
    readerKind: s.reader.kind,
    badLayout: s.reader.badLayout > 0,
    webNfc: web,
    sound: s.prefs.sound,
    video: video ?? SCAN_VIDEO,
  };
  const view = useHardware(inputs);
  const { refresh } = view;
  const testingNow = useRef(false);
  const [testRead, setTestRead] = useState<TestRead | null>(null);
  const onTesting = useCallback(
    (on: boolean) => {
      testingNow.current = on;
      runtime.hold(on);
      if (!on) setTestRead(null);
    },
    [runtime],
  );
  useEffect(() => () => runtime.hold(false), [runtime]);
  const serial = useRef<ReturnType<typeof createSerialScanners> | null>(null);
  // Made inside the effect: StrictMode's second mount needs a live instance, not a stopped one.
  useEffect(() => {
    const next = createSerialScanners(
      (navigator as Navigator & { serial?: SerialLike }).serial,
      (code) => {
        if (testingNow.current) setTestRead({ code, gap: null });
        else runtime.emit({ method: 'wedge', code });
      },
      refresh,
    );
    serial.current = next;
    void next.resume();
    return () => {
      next.stop();
      serial.current = null;
    };
  }, [runtime, refresh]);
  const act = (_item: HardwareItem, action: HardwareAction) => {
    switch (action.kind) {
      case 'allow':
        if (s.started) runtime.camera.start();
        else void askCamera().then(refresh);
        return;
      case 'retry':
        if (_item.kind === 'nfc') void runtime.webNfc.arm().then(setWeb);
        else runtime.camera.start();
        return;
      case 'use':
        lens[1](action.choice);
        runtime.camera.choose(action.choice);
        return;
      case 'nfc':
        void runtime.webNfc.arm().then(setWeb);
        return;
      case 'connect':
        void serial.current?.connect().then(refresh);
        return;
    }
  };
  return (
    <HardwareSurface
      view={view}
      inputs={inputs}
      onAction={act}
      onTesting={onTesting}
      testRead={testRead}
    />
  );
}

/** A monitor's hardware: it reads nothing, so the panel lists what the device has. */
export function MonitorHardware({ online }: { online: boolean }) {
  const inputs: HardwareInputs = {
    reads: false,
    focused: true,
    readerUsable: false,
    camera: null,
    cameraChoice: 'back',
    hasWide: false,
    started: false,
    online,
    queued: 0,
    readerKind: 'none',
    badLayout: false,
    webNfc: 'idle',
    sound: null,
  };
  return <HardwareSurface view={useHardware(inputs)} inputs={inputs} />;
}
