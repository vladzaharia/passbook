import { useEffect, useMemo, useState } from 'react';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { toast } from '../../../ui/toaster.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { toFail } from '../../api/to-fail.ts';
import { insidePort } from '../../inside/inside-api.ts';
import { useInside } from '../../inside/use-inside.ts';
import type { FailInfo } from '../../machine/ports.ts';
import type { KeyValue } from '../../offline/wipe.ts';
import type { ScanRuntime } from '../../platform/runtime.ts';
import { rollCallPort } from '../../roll-call/roll-call-api.ts';
import type { QueuedMark } from '../../roll-call/roll-call-model.ts';
import { useRollCall } from '../../roll-call/use-roll-call.ts';
import { ACCESS_COPY } from '../../ui/copy-access.ts';
import { isDeskRole } from '../../ui/place.ts';
import { useDevices, useShift } from './use-floor-data.ts';
import type { Hub } from './use-hub.ts';

const ROLL = ACCESS_COPY.roll;

/**
 * What the floor and the Who's in and roll call views read. One hub connection feeds
 * all of it: a pulse reads again, and the polls under each read carry on when the hub is away.
 * Desk and Manager scanners only; a Door has no floor.
 */
export function useFloor({
  api,
  runtime,
  session,
  online,
  hub,
  tracks,
  wide,
  view,
  shiftStart,
  onBlocked,
}: {
  api: ScanApi;
  runtime: ScanRuntime;
  session: ScanSession;
  online: boolean;
  hub: Hub;
  /** The scanner counts a place: Who's in and roll call exist. */
  tracks: boolean;
  /** The floor column is showing. */
  wide: boolean;
  view: string;
  shiftStart: number;
  onBlocked: (info: FailInfo) => void;
}) {
  const desk = isDeskRole(session);
  const [rollView, setRollView] = useState(false);
  const insideNeeded = tracks && (wide || view === 'inside' || rollView);
  const inside = useInside({
    api: useMemo(() => insidePort(api), [api]),
    active: insideNeeded,
    online,
    onFail: onBlocked,
  });
  const { retry } = inside;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a pulse is the reason to read again
  useEffect(() => {
    if (!insideNeeded || !online || hub.pulses === 0) return;
    const t = setTimeout(() => void retry(), 200);
    return () => clearTimeout(t);
  }, [hub.pulses]);
  const roll = useRollCall({
    port: useMemo(() => rollCallPort(api), [api]),
    enabled: tracks,
    online,
    by: '',
    onAppear: () => setRollView(true),
    connect: hub.connect,
    onRefused: (items) => {
      const people = new Map(roll.call?.people.map((p) => [p.passId, p.holder]) ?? []);
      const reasons = ROLL.refused as Record<string, string>;
      for (const { passId, code } of items.slice(0, 3))
        toast.info(
          `${people.get(passId) ?? ACCESS_COPY.inside.unnamed}: ${reasons[code] ?? ROLL.refused.other}`,
        );
    },
    onBlocked: (error) => onBlocked(toFail(error)),
    store: runtime.rollCallQueue as KeyValue<QueuedMark[]>,
  });
  // A call that opened elsewhere takes the list pane; one that ended gives it back.
  const open = roll.call !== null;
  useEffect(() => {
    setRollView(open);
  }, [open]);
  const gate = { online, kick: hub.pulses * 2 + Number(hub.up) };
  // Presence and shift totals do not move with a scan: their own timers carry them.
  const devices = useDevices(api, { ...gate, kick: 0, active: desk && wide });
  const shift = useShift(api, shiftStart, { ...gate, kick: 0, active: wide });
  return { desk, tracks, hub, inside, roll, devices, shift };
}
export type Floor = ReturnType<typeof useFloor>;
