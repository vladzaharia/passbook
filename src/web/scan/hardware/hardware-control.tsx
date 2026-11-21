import { useEffect, useMemo, useState } from 'react';
import { savedCount } from '../machine/derive.ts';
import type { ScanState } from '../machine/types.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import type { CameraChoice } from '../ui/scan-menu.tsx';
import { guideOf } from './guide.ts';
import { HardwarePanel } from './hardware-panel.tsx';
import { HardwarePill } from './hardware-pill.tsx';
import { createSerialScanners, type SerialLike } from './serial-scanners.ts';
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
}: {
  view: HardwareView;
  inputs: Pick<HardwareInputs, 'reads' | 'camera'>;
  onAction?: (item: HardwareItem, action: HardwareAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const { refresh } = view;
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);
  return (
    <>
      <HardwarePill icons={view.icons} reads={view.reads} onOpen={() => setOpen(true)} />
      <span role="status" aria-live="polite" className="scan-sr" key={view.change?.n}>
        {view.change?.text ?? ''}
      </span>
      {open ? (
        <HardwarePanel
          items={view.items}
          steps={guideOf(view.items, { reads: inputs.reads, camera: inputs.camera !== null })}
          testing={testing}
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
}: {
  runtime: ScanRuntime;
  s: ScanState;
  /** The scanner's one video element when absent. */
  video?: { current: HTMLVideoElement | null };
  lens: [CameraChoice, (choice: CameraChoice) => void];
  /** False where the view runs no camera (the operator desk). */
  camera: boolean;
}) {
  const [web, setWeb] = useState(runtime.webNfc.status());
  const inputs: HardwareInputs = {
    reads: true,
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
  const serial = useMemo(
    () =>
      createSerialScanners(
        (navigator as Navigator & { serial?: SerialLike }).serial,
        (code) => runtime.emit({ method: 'wedge', code }),
        refresh,
      ),
    [runtime, refresh],
  );
  useEffect(() => {
    void serial.resume();
    return serial.stop;
  }, [serial]);
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
        void serial.connect().then(refresh);
        return;
    }
  };
  return <HardwareSurface view={view} inputs={inputs} onAction={act} />;
}

/** A monitor's hardware: it reads nothing, so the panel lists what the device has. */
export function MonitorHardware({ online }: { online: boolean }) {
  const inputs: HardwareInputs = {
    reads: false,
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
