import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WEDGE_SCAN_EVENT } from '../input/wedge-source.ts';
import { canBuzz } from '../platform/haptics.ts';
import { useNativeCapabilities } from '../platform/use-native-capabilities.ts';
import { hardwareItems, WEDGE_ACTIVE_MS } from './items.ts';
import { changeOf, type PillIcon, pillIcons } from './pill-model.ts';
import { browserProbeEnv, type ProbeEnv, probeHardware, watchHardware } from './probe.ts';
import { publishHardware } from './report.ts';
import type { HardwareItem, LiveHardware, Probe } from './types.ts';

export type HardwareInputs = Omit<LiveHardware, 'native' | 'wedge' | 'now' | 'activeCameraId'> & {
  badLayout: boolean;
  /** The scanner's video element: its track names the camera in use. */
  video?: { current: HTMLVideoElement | null } | undefined;
};

export interface HardwareView {
  items: HardwareItem[];
  icons: PillIcon[];
  /** Null until the first enumeration ends. */
  probe: Probe | null;
  /** The latest change worth announcing; re-keyed per change. */
  change: { text: string; n: number } | null;
  /** Bumps on each wedge read: the pill blinks the scanner. */
  reads: number;
  refresh: () => void;
}

function activeCameraId(video: HardwareInputs['video']): string | null {
  const stream = video?.current?.srcObject;
  if (!stream || typeof (stream as MediaStream).getVideoTracks !== 'function') return null;
  return (stream as MediaStream).getVideoTracks()[0]?.getSettings?.().deviceId ?? null;
}

/** Enumeration plus what the running scanner knows, as rows, pill icons and announcements. */
export function useHardware(inputs: HardwareInputs, env: ProbeEnv | null = null): HardwareView {
  const native = useNativeCapabilities();
  const probeEnv = useMemo(() => env ?? browserProbeEnv(canBuzz()), [env]);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [reads, setReads] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [change, setChange] = useState<HardwareView['change']>(null);
  const run = useRef(0);
  const refresh = useCallback(() => {
    const token = ++run.current;
    void probeHardware(probeEnv).then((next) => {
      if (token === run.current) setProbe(next);
    });
  }, [probeEnv]);
  useEffect(() => {
    refresh();
    return watchHardware(probeEnv, refresh);
  }, [probeEnv, refresh]);
  useEffect(() => {
    if (!inputs.reads) return;
    const onRead = () => {
      setSeenAt(Date.now());
      setNow(Date.now());
      setReads((n) => n + 1);
    };
    window.addEventListener(WEDGE_SCAN_EVENT, onRead);
    return () => window.removeEventListener(WEDGE_SCAN_EVENT, onRead);
  }, [inputs.reads]);
  // The scanner icon settles from on to ready a minute after the last read.
  useEffect(() => {
    if (seenAt === null) return;
    const t = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, seenAt + WEDGE_ACTIVE_MS - Date.now()) + 1,
    );
    return () => clearTimeout(t);
  }, [seenAt]);
  // A camera that starts or stops can change the labels the browser gives.
  useEffect(() => {
    if (inputs.camera === 'live' || inputs.camera === 'blocked') refresh();
  }, [inputs.camera, refresh]);
  const live: LiveHardware = {
    ...inputs,
    native,
    now,
    activeCameraId: inputs.camera === 'live' ? activeCameraId(inputs.video) : null,
    wedge: { seenAt, badLayout: inputs.badLayout, tracked: inputs.reads },
  };
  const items = probe ? hardwareItems(probe, live) : [];
  const icons = pillIcons(items);
  const key = JSON.stringify(icons);
  const before = useRef<PillIcon[] | null>(null);
  useEffect(() => {
    const next = JSON.parse(key) as PillIcon[];
    if (!probe) return;
    const prev = before.current;
    before.current = next;
    if (!prev) return;
    const text = changeOf(prev, next);
    if (text) setChange((c) => ({ text, n: (c?.n ?? 0) + 1 }));
  }, [key, probe]);
  const summary = probe ? JSON.stringify(items) : '';
  useEffect(() => {
    if (summary) publishHardware(JSON.parse(summary) as HardwareItem[]);
  }, [summary]);
  return { items, icons, probe, change, reads, refresh };
}
