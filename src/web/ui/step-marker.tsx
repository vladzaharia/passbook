import { Clock, Loader2, X } from 'lucide-react';
import { type CSSProperties, Fragment, type ReactNode, useRef } from 'react';
import { cn } from '../lib/cn.ts';
import { Tick } from './checkbox.tsx';

export type StepMarkerState =
  | 'done'
  | 'current'
  | 'todo'
  | 'skipped'
  | 'invalid'
  | 'working'
  | 'waiting'
  | 'failed';

const SIZE = {
  sm: 'size-5 text-xs',
  md: 'size-6 text-xs',
  lg: 'size-9 text-sm',
} as const;
const WORD: Partial<Record<StepMarkerState, string>> = {
  done: 'done',
  current: 'current',
  working: 'in progress',
  waiting: 'waiting',
  failed: 'failed',
  invalid: 'needs attention',
  skipped: 'skipped',
};
// Important: a host's `[&_svg]` rule (a menu item sets size and a muted colour) must not restyle the glyph.
const TICK = {
  sm: '!size-3 !text-current',
  md: '!size-3.5 !text-current',
  lg: '!size-4 !text-current',
} as const;

export interface StepMarkerProps {
  state: StepMarkerState;
  /** The step's number, shown while it is current or still to do. */
  n: number;
  /** 20, 24 and 36 px. */
  size?: keyof typeof SIZE;
  /** The marker became done after it mounted: it pops and the tick draws. */
  fresh?: boolean;
}

/**
 * The one step circle: a wizard's rail, a checklist, a progress list. Decorative: the caller names
 * the step and says its state in words (state is never colour alone: tick, number, dash, "!").
 */
export function StepMarker({ state, n, size = 'md', fresh }: StepMarkerProps) {
  return (
    <span
      aria-hidden
      data-state={state}
      className={cn(
        'relative z-10 inline-flex shrink-0 items-center justify-center rounded-full border font-semibold tabular-nums wl-colors',
        SIZE[size],
        state === 'done' && 'border-accent bg-accent text-accent-on',
        state === 'done' && fresh && 'wl-step-done',
        state === 'current' && 'border-accent bg-surface-overlay text-accent-fg',
        (state === 'todo' || state === 'skipped') &&
          'border-border-strong bg-surface-overlay text-fg-muted',
        state === 'skipped' && 'border-dashed',
        state === 'invalid' && 'border-danger bg-surface-overlay text-danger ring-2 ring-danger/25',
        state === 'working' && 'border-accent bg-surface-overlay text-accent-fg',
        state === 'waiting' && 'border-dashed border-accent bg-surface-overlay text-accent-fg',
        state === 'failed' && 'border-danger bg-danger text-danger-on',
      )}
    >
      {state === 'done' ? (
        <Tick draw={fresh} className={TICK[size]} />
      ) : state === 'skipped' ? (
        '–'
      ) : state === 'invalid' ? (
        '!'
      ) : state === 'working' ? (
        <Loader2 aria-hidden className={cn('wl-spin wl-essential', TICK[size])} />
      ) : state === 'waiting' ? (
        <Clock aria-hidden className={TICK[size]} />
      ) : state === 'failed' ? (
        <X aria-hidden className={TICK[size]} />
      ) : (
        n
      )}
    </span>
  );
}

export interface StepListItem {
  id: string;
  label: ReactNode;
  state: StepMarkerState;
  /** Under the label. */
  detail?: ReactNode;
  /** Right of the label, tabular: "4 of 12", "By Dec 2", "0:12". */
  meta?: ReactNode;
  /** A heading above the first step of a run of steps ("Old sandbox"). */
  group?: string;
}

/** Ids that became done after the list mounted: their tick draws. */
function useFreshDone(items: readonly StepListItem[]): ReadonlySet<string> {
  const seen = useRef<Map<string, StepMarkerState>>(new Map());
  const fresh = useRef<Set<string>>(new Set());
  for (const item of items) {
    const before = seen.current.get(item.id);
    if (before !== undefined && before !== 'done' && item.state === 'done')
      fresh.current.add(item.id);
    seen.current.set(item.id, item.state);
  }
  return fresh.current;
}

/**
 * A read-only vertical list of markers joined by a connector that fills as steps finish: progress
 * the server drives (a managed setup, a tag wait, an operation). `meta` sits on the right and
 * `group` heads a run of steps; a step that finishes while the list is on screen draws its tick.
 */
export function StepList({
  items,
  size = 'md',
  label,
}: {
  items: readonly StepListItem[];
  size?: keyof typeof SIZE;
  /** Names the list for screen readers. */
  label: string;
}) {
  const fresh = useFreshDone(items);
  return (
    <ol aria-label={label} className="relative flex flex-col">
      {items.map((item, i) => {
        const next = items[i + 1];
        const last = !next || next.group !== undefined;
        return (
          <Fragment key={item.id}>
            {item.group ? (
              <li className={cn('pb-2 text-xs font-medium text-fg-muted', i > 0 && 'pt-1')}>
                {item.group}
              </li>
            ) : null}
            <li
              aria-current={
                item.state === 'current' || item.state === 'working' || item.state === 'waiting'
                  ? 'step'
                  : undefined
              }
              className={cn('relative flex items-start gap-3', i < items.length - 1 && 'pb-5')}
            >
              {last ? null : (
                <span
                  aria-hidden
                  className={cn(
                    'absolute bottom-0 w-px -translate-x-1/2 bg-border',
                    size === 'lg' ? 'top-9 left-[1.125rem]' : 'top-6 left-3',
                  )}
                >
                  <span
                    className="wl-fill absolute inset-0 origin-top bg-accent"
                    style={
                      { transform: `scaleY(${item.state === 'done' ? 1 : 0})` } as CSSProperties
                    }
                  />
                </span>
              )}
              <StepMarker
                state={item.state}
                n={i + 1}
                size={size}
                fresh={fresh.has(item.id) || undefined}
              />
              <span className="flex min-w-0 flex-1 flex-col pt-0.5">
                <span className="flex items-baseline justify-between gap-3">
                  <span
                    className={cn(
                      'min-w-0 text-sm',
                      item.state === 'todo' || item.state === 'skipped'
                        ? 'text-fg-muted'
                        : 'text-fg-strong',
                      item.state === 'skipped' && 'line-through',
                    )}
                  >
                    {item.label}
                    {WORD[item.state] ? (
                      <span className="sr-only"> ({WORD[item.state]})</span>
                    ) : null}
                  </span>
                  {item.meta ? (
                    <span className="shrink-0 text-xs tabular-nums text-fg-muted">{item.meta}</span>
                  ) : null}
                </span>
                {item.detail ? <span className="text-xs text-fg-muted">{item.detail}</span> : null}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
