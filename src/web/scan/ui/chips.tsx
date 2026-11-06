import { CloudOff, Keyboard, X } from 'lucide-react';
import type { Mode } from '../../../shared/contracts/common.ts';
import { CountUp } from '../../ui/count-up.tsx';
import { ModeLabel as ModePill } from '../../ui/layout/mode-label.tsx';

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

export type ReaderChipState = 'idle' | 'ready' | 'paused' | 'layout';

const READER_TEXT: Record<ReaderChipState, string> = {
  idle: 'Reader',
  ready: 'Reader ready',
  paused: 'Reader paused',
  layout: 'Set the keyboard to U.S.',
};

/** A tap on a paused reader refocuses its field. */
export function ReaderChip({ state, onTap }: { state: ReaderChipState; onTap?: () => void }) {
  const amber = state === 'paused' || state === 'layout';
  const content = (
    <>
      <Keyboard aria-hidden size={14} />
      {READER_TEXT[state]}
    </>
  );
  return amber && onTap ? (
    <button type="button" className="scan-chip" data-tone="amber" onClick={onTap}>
      {content}
    </button>
  ) : (
    <span className="scan-chip" data-tone={amber ? 'amber' : undefined}>
      {content}
    </span>
  );
}

export type SyncChipState =
  | { kind: 'offline'; queued: number }
  | { kind: 'syncing'; queued: number }
  | { kind: 'stale'; queued: number };

export function SyncChip({ state }: { state: SyncChipState }) {
  if (state.kind === 'offline') {
    return (
      <span className="scan-chip" data-tone="slate">
        <CloudOff aria-hidden size={14} />
        Offline
        {state.queued > 0 ? <span>{state.queued}</span> : null}
      </span>
    );
  }
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
