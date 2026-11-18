import { CountUp } from '../../ui/count-up.tsx';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import type { InsidePlace } from './inside-types.ts';

/** A bar per tracked place. Picking one filters the list; All shows them together. */
export function InsidePlaces({
  places,
  total,
  value,
  onPick,
}: {
  places: InsidePlace[];
  total: number;
  value: string | null;
  onPick: (place: string | null) => void;
}) {
  if (places.length === 0) return null;
  const items =
    places.length > 1
      ? [{ key: null, name: ACCESS_COPY.inside.allPlaces, inNow: total, capacity: null }]
      : [];
  const all = [
    ...items,
    ...places.map((p) => ({ key: p.place, name: p.name, inNow: p.inNow, capacity: p.capacity })),
  ];
  return (
    <div className="scan-in-places" role="group" aria-label="Places">
      {all.map((p) => {
        const full = p.capacity !== null && p.inNow >= p.capacity;
        return (
          <button
            key={p.key ?? 'all'}
            type="button"
            className="scan-in-place"
            aria-pressed={places.length > 1 ? value === p.key : undefined}
            data-full={full || undefined}
            disabled={places.length === 1}
            onClick={() => onPick(p.key)}
          >
            <span className="scan-in-place-name">{p.name}</span>
            <span className="scan-in-place-count">
              <CountUp value={p.inNow} />
              {p.capacity !== null ? <span>/{p.capacity}</span> : null}
            </span>
            {p.capacity !== null ? (
              <span aria-hidden className="scan-in-bar">
                <i style={{ width: `${Math.min(100, (p.inNow / p.capacity) * 100)}%` }} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
