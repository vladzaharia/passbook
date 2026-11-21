import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { cn } from '../../../lib/cn.ts';
import { Select } from '../../../ui/index.ts';
import { type MatchState, shownRows } from './match-model.ts';

/** Rows that still need a column, a value pick or a date format. */
export function needs(state: MatchState): number {
  return shownRows(state).filter((r) => {
    if (r.from.length === 0) return r.required && !r.hasDefault;
    if (r.kind === 'choice') return r.values.some((v) => v.to === null);
    return r.kind === 'date' && r.date?.format === null && (r.date.choices.length ?? 0) > 1;
  }).length;
}

/** Values left to choose, for the line by the button. */
export const valuesLeft = (state: MatchState): number =>
  shownRows(state).reduce(
    (n, r) => n + (r.from.length ? r.values.filter((v) => v.to === null).length : 0),
    0,
  );

const RING = 2 * Math.PI * 16;

/** The share of columns used as a ring, and what is left to do. */
export function MatchSummary({ state, columns }: { state: MatchState; columns: number }) {
  const used = columns - state.unused.length;
  const share = columns > 0 ? used / columns : 1;
  const open = needs(state);
  return (
    <div className="flex items-center gap-4 px-4 py-4 sm:px-6">
      <div className="relative size-12 shrink-0">
        <svg viewBox="0 0 40 40" aria-hidden className="size-12 -rotate-90">
          <circle
            cx="20"
            cy="20"
            r="16"
            fill="none"
            strokeWidth="4"
            className="stroke-surface-sunken"
          />
          <circle
            cx="20"
            cy="20"
            r="16"
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - share)}
            className={cn(
              'stroke-accent motion-safe:transition-[stroke-dashoffset] motion-safe:duration-(--wl-dur-card)',
            )}
          />
        </svg>
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums text-fg-strong"
        >
          {Math.round(share * 100)}%
        </span>
      </div>
      <div>
        <p className="text-sm font-semibold text-fg-strong">{C.match.used(used, columns)}</p>
        <p className="text-xs text-fg-muted">
          {open === 0 ? C.match.allReady : C.match.needValues(open)}
        </p>
      </div>
    </div>
  );
}

/** Columns no field uses: pick a field that has none, and the column feeds it. */
export function UnusedColumns({
  state,
  onUse,
}: {
  state: MatchState;
  onUse: (rowKey: string, pointer: string) => void;
}) {
  const empty = shownRows(state).filter((r) => r.from.length === 0);
  if (state.unused.length === 0 || empty.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 sm:px-6">
      <span className="text-xs text-fg-muted">{C.match.notUsed}</span>
      {state.unused.map((u) => (
        <Select
          key={u.pointer}
          aria-label={C.match.assignColumn(u.label)}
          className="h-8 w-auto rounded-full border-dashed text-xs"
          value={undefined}
          placeholder={`+ ${u.label}`}
          onValueChange={(rowKey) => onUse(rowKey, u.pointer)}
          options={empty.map((r) => ({ value: r.key, label: r.label }))}
        />
      ))}
    </div>
  );
}

/** The saved mapping the admin may switch to. */
export function SavedPicker({
  saved,
  onPick,
}: {
  saved: readonly { name: string }[];
  onPick: (name: string) => void;
}) {
  if (saved.length === 0) return null;
  return (
    <Select
      aria-label={C.match.savedMappings}
      className="w-48"
      placeholder={C.match.savedMappings}
      value={undefined}
      onValueChange={onPick}
      options={saved.map((s) => ({ value: s.name, label: s.name }))}
    />
  );
}
