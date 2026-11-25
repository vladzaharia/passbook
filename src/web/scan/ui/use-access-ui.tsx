import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanApi } from '../api/scan-api.ts';
import type { MachineEvent } from '../machine/access-events.ts';
import { nextDirection, type ShownDirection, shownDirection } from '../machine/direction-view.ts';
import type { Counts } from '../machine/types.ts';
import type { KeyValue } from '../offline/wipe.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import type { QueuedMark } from '../roll-call/roll-call-model.ts';
import { CountChip, PlaceChip } from './chips.tsx';
import { DirectionChip } from './direction-chip.tsx';
import { DirectionSheet } from './direction-sheet.tsx';
import { isDeskRole, trackedPlace } from './place.ts';
import { useDirectionPin } from './use-direction-pin.ts';

const InsideHost = lazy(() => import('../inside/inside-host.tsx'));

type Sheet = 'direction' | 'inside' | null;

/**
 * Access and occupancy in the scanner's loop: the direction chip and sheet, the count chip of a
 * tracked place, and Who's in for Desk scanners. Opening a sheet raises the machine's overlay (the
 * scanner holds still); a scan result, which clears the overlay, closes it.
 */
export function useAccessUi({
  runtime,
  session,
  api,
  counts,
  online,
  overlay,
  dispatch,
  handheld = false,
  scopeDirection = 'in',
  hosts = true,
}: {
  /** A handheld moves the direction chip to the thumb row and the state line. */
  handheld?: boolean;
  scopeDirection?: 'in' | 'out';
  runtime: ScanRuntime;
  session: ScanSession;
  api: ScanApi;
  counts: Counts;
  online: boolean;
  overlay: string | null;
  dispatch: (event: MachineEvent) => void;
  /** Mount Who's in as a sheet. The operator console draws it itself. */
  hosts?: boolean;
}): {
  chips: ReactNode;
  inside: { count: number; onOpen: () => void } | undefined;
  /** The way this scanner reads, when it has one worth showing; `onCycle` on a Both scanner. */
  direction: { value: ShownDirection; onCycle?: () => void } | undefined;
  layer: ReactNode;
} {
  const pin = useDirectionPin(runtime.pin);
  const [sheet, setSheet] = useState<Sheet>(null);
  useEffect(() => {
    if (overlay === null) setSheet(null);
  }, [overlay]);
  const show = (next: Sheet) => {
    setSheet(next);
    dispatch({
      type: 'overlay',
      open: next === null ? null : next === 'direction' ? 'settings' : 'recent',
    });
  };
  const place = trackedPlace(counts, session.event);
  const setting = session.scanner?.settings.direction ?? 'in';
  const syncPlaces = (places: { name: string; inNow: number }[]) => {
    const now = places.find((p) => p.name === place?.name);
    if (place && counts.place && now && now.inNow !== place.inNow)
      dispatch({
        type: 'counts',
        counts: { ...counts, place: { ...counts.place, inNow: now.inNow } },
      });
  };
  const deskInside = place !== null && isDeskRole(session);
  const shown = shownDirection(setting, pin, scopeDirection);
  const direction =
    place !== null || setting !== 'in'
      ? {
          value: shown,
          ...(setting === 'both'
            ? { onCycle: () => runtime.pin.set(nextDirection(shown, scopeDirection)) }
            : {}),
        }
      : undefined;
  const chips = place ? (
    <>
      {handheld ? null : (
        <DirectionChip setting={setting} pin={pin} onOpen={() => show('direction')} />
      )}
      <PlaceChip name={place.name} inNow={place.inNow} capacity={place.capacity} />
    </>
  ) : (
    <CountChip
      count={counts.event?.arrived ?? counts.today}
      capacity={counts.event?.expected}
      today={!counts.event}
    />
  );
  const layer = (
    <>
      <DirectionSheet
        open={sheet === 'direction'}
        pin={pin}
        onPick={(direction) => runtime.pin.set(direction)}
        onClose={() => show(null)}
      />
      {hosts && deskInside ? (
        <Suspense fallback={null}>
          <InsideHost
            api={api}
            open={sheet === 'inside'}
            online={online}
            onClose={() => show(null)}
            onOpen={() => show('inside')}
            store={runtime.rollCallQueue as KeyValue<QueuedMark[]>}
            onOpenRow={(row) => {
              show(null);
              runtime.emit({ method: 'manual', passId: row.passId });
            }}
            onFail={(info) => dispatch({ type: 'fail', key: '', ...info })}
            onPlaces={syncPlaces}
          />
        </Suspense>
      ) : null}
    </>
  );
  return {
    chips,
    direction,
    inside: deskInside && place ? { count: place.inNow, onOpen: () => show('inside') } : undefined,
    layer,
  };
}
