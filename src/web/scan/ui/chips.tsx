import { CloudOff, Users, X } from 'lucide-react';
import type { Mode } from '../../../shared/contracts/common.ts';
import { plural } from '../../../shared/plural.ts';
import { CountUp } from '../../ui/count-up.tsx';
import { ModeLabel as ModePill } from '../../ui/layout/mode-label.tsx';
import { pendingBadge, savedCount } from '../machine/derive.ts';
import type { ScanState } from '../machine/types.ts';
import { fill } from './copy.ts';
import { ACCESS_COPY } from './copy-access.ts';

/** Test marker: first in the capsule, on test scanners only; live shows nothing. */
export function TestChip({ mode }: { mode: Mode | undefined }) {
  if (mode !== 'test') return null;
  return <ModePill mode="test" className="scan-test" />;
}

/**
 * Event scanners: `312/500` on a phone, `312 of 500 in` wide, `290 in · 22 out` with re-entry.
 * Template scanners: `Today 42`. The width is reserved for the longest value.
 */
export function CountChip({
  count,
  capacity,
  out,
  today,
  wide,
}: {
  count: number;
  capacity?: number | null;
  out?: number | null;
  today?: boolean;
  wide?: boolean;
}) {
  return (
    <span className="scan-chip" data-slot="count" data-testid="scan-count">
      <span>
        {today ? 'Today ' : null}
        <CountUp value={count} />
        {out != null ? (
          <>
            {' in · '}
            <CountUp value={out} />
            {' out'}
          </>
        ) : capacity != null ? (
          wide ? (
            ` of ${capacity} in`
          ) : (
            `/${capacity}`
          )
        ) : null}
      </span>
    </span>
  );
}

/** A scanner that counts a place: `42/60` with the people icon. A full place turns amber. */
export function PlaceChip({
  name,
  inNow,
  capacity,
  wide,
}: {
  name: string;
  inNow: number;
  capacity: number | null;
  wide?: boolean;
}) {
  const label = fill(capacity === null ? ACCESS_COPY.place.chip : ACCESS_COPY.place.chipOf, {
    place: name,
    in: inNow,
    capacity: capacity ?? 0,
  });
  return (
    <span
      className="scan-chip"
      data-slot="count"
      data-testid="scan-count"
      data-place=""
      data-tone={capacity !== null && inNow >= capacity ? 'amber' : undefined}
      role="img"
      aria-label={label}
    >
      <Users aria-hidden size={14} />
      <span aria-hidden>
        <CountUp value={inNow} />
        {capacity !== null ? (wide ? ` of ${capacity} in` : `/${capacity}`) : null}
      </span>
    </span>
  );
}

export type SyncChipState =
  | { kind: 'offline'; queued: number }
  | { kind: 'syncing'; queued: number }
  | { kind: 'stale'; queued: number }
  /** Synced, and some entries the door let in did not hold. */
  | { kind: 'conflicts'; queued: number };

/** The sync chip, or none: offline, waiting to sync, or synced with entries that did not hold. */
export function syncChipOf(s: ScanState, now: number): SyncChipState | null {
  const queued = savedCount(s);
  if (!s.online) return { kind: 'offline', queued };
  if (s.queue.pending > 0) return { kind: pendingBadge(s, now).late ? 'stale' : 'syncing', queued };
  return s.queue.conflicts > 0 ? { kind: 'conflicts', queued: s.queue.conflicts } : null;
}

export function SyncChip({ state }: { state: SyncChipState }) {
  if (state.kind === 'offline') {
    return (
      <span className="scan-chip" data-tone="slate">
        <CloudOff aria-hidden size={14} />
        <span className="scan-chip-word">Offline</span>
        {state.queued > 0 ? <span>{state.queued}</span> : null}
      </span>
    );
  }
  if (state.kind === 'conflicts')
    return (
      <span className="scan-chip" data-tone="amber" data-testid="sync-conflicts">
        {plural(state.queued, 'conflict')}
      </span>
    );
  return state.kind === 'syncing' ? (
    <span className="scan-chip">Syncing {state.queued}</span>
  ) : (
    <span className="scan-chip" data-tone="amber">
      {state.queued} not synced
    </span>
  );
}

/** The armed ready action: the next scans apply it. */
export function ReadyChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="scan-chip" data-tone="accent">
      Ready: {label}
      <button type="button" aria-label={`Clear ${label}`} className="scan-chip-x" onClick={onClear}>
        <X aria-hidden size={14} />
      </button>
    </span>
  );
}
