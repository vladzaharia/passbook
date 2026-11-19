import { useMemo } from 'react';
import type { ScanApi } from '../api/scan-api.ts';
import { insidePort } from '../inside/inside-api.ts';
import { InsidePanel } from '../inside/inside-panel.tsx';
import { MarkOutButton } from '../inside/inside-row.tsx';
import type { InsideRow } from '../inside/inside-types.ts';
import { useInside } from '../inside/use-inside.ts';

/**
 * The monitor's main content: the desk's Who's in for the places this screen watches. The server
 * decides the photos (the monitor's audience) and the rows; Mark as out is the signed-in person's.
 */
export function MonitorInside({
  api,
  online,
  onMarked,
}: {
  api: ScanApi;
  online: boolean;
  onMarked: () => void;
}) {
  const port = useMemo(() => insidePort(api), [api]);
  const inside = useInside({ api: port, active: true, online });
  const stale = !online || inside.state.error;
  return (
    <section aria-label="Who's in" className="mon-inside">
      <InsidePanel
        active
        inside={inside}
        online={online}
        onOpenRow={noop}
        trailing={(row: InsideRow) => (
          <MarkOutButton
            row={row}
            disabled={stale}
            onMark={(r) => {
              void inside.markOut(r).then(onMarked);
            }}
          />
        )}
      />
    </section>
  );
}

function noop() {}
