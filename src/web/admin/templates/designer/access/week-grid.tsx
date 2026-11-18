import { Copy, Plus } from 'lucide-react';
import { useState } from 'react';
import type { AccessDay, WeeklyHours } from '@/passkit/types.ts';
import { cn } from '../../../../lib/cn.ts';
import { Button, CheckboxField } from '../../../../ui/index.ts';
import {
  copyDay,
  copyTargets,
  DAY_NAME,
  DAY_SHORT,
  DAYS,
  MAX_SPANS,
  nextSpan,
  outsidePlan,
  setDay,
  spanText,
  weekProblems,
} from './hours.ts';
import { SpanEditor } from './span-editor.tsx';

export interface WeekGridProps {
  /** Names the grid for assistive tech: "Off-peak hours". */
  label: string;
  hours: WeeklyHours | undefined;
  onChange: (hours: WeeklyHours | undefined, merge?: string) => void;
  /** Messages from the issues, by day; the grid's own overlap check adds to them. */
  errors?: Partial<Record<AccessDay, string>>;
  /** A zone's grid: spans outside these hours are struck. */
  within?: WeeklyHours | undefined;
  /** Edits of one grid join one undo step. */
  mergeKey: string;
}

const aloud = (day: AccessDay, text: string) =>
  `${DAY_NAME[day]}, ${spanText(text).replace(' – ', ' to ')}, edit`;

/**
 * A week as rows: the day, its spans as buttons, Add hours, Closed, and a copy. A span opens its
 * two time fields under the row; overlaps and every issue say so under the same row.
 */
export function WeekGrid({ label, hours, onChange, errors, within, mergeKey }: WeekGridProps) {
  const [open, setOpen] = useState<{ day: AccessDay; at: number } | null>(null);
  const own = weekProblems(hours);
  const replace = (day: AccessDay, spans: readonly string[], merge?: string) =>
    onChange(setDay(hours, day, spans), merge);
  return (
    <table aria-label={`${label} hours`} className="ac-grid block w-full [&>tbody+tbody]:mt-1.5">
      {DAYS.map((day) => {
        const spans = hours?.[day] ?? [];
        const closed = spans.length === 0;
        const problem = errors?.[day] ?? own[day];
        const target = copyTargets(day);
        const editing = open?.day === day ? open.at : null;
        return (
          <tbody
            key={day}
            data-closed={closed || undefined}
            data-invalid={problem ? true : undefined}
            className="ac-day block rounded-md border border-border-subtle bg-surface-raised px-2 py-1.5"
          >
            <tr className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <th
                scope="row"
                className="block w-10 shrink-0 text-left text-sm font-medium text-fg-strong"
              >
                <abbr title={DAY_NAME[day]} className="no-underline">
                  {DAY_SHORT[day]}
                </abbr>
                <span className="sr-only">{DAY_NAME[day].slice(DAY_SHORT[day].length)}</span>
              </th>
              <td className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {closed ? (
                  <span className="text-sm text-fg-muted">Closed</span>
                ) : (
                  spans.map((text, at) => {
                    const nth = spans.slice(0, at).filter((t) => t === text).length;
                    const out = outsidePlan(within, day, text);
                    return (
                      <button
                        // A span has no id: its text and which of equal ones it is.
                        key={`${text}#${nth}`}
                        type="button"
                        aria-label={aloud(day, text)}
                        aria-expanded={editing === at}
                        data-out={out || undefined}
                        className={cn(
                          'ac-span inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-sm pointer-coarse:min-h-11',
                          'border-border-strong bg-surface-sunken text-fg-strong hover:border-fg-muted',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                          editing === at && 'border-accent bg-accent-subtle',
                          out && 'line-through decoration-fg-muted',
                        )}
                        onClick={() => setOpen(editing === at ? null : { day, at })}
                      >
                        {spanText(text)}
                        {out ? (
                          <span className="text-xs text-fg-muted no-underline">
                            <span className="sr-only">: </span>Outside the plan
                          </span>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </td>
              <td className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <CheckboxField
                  label="Closed"
                  aria-label={`${DAY_NAME[day]} closed`}
                  checked={closed}
                  onCheckedChange={(on) => {
                    setOpen(null);
                    replace(day, on === true ? [] : [nextSpan([])], `week:${mergeKey}`);
                  }}
                />
              </td>
            </tr>
            <tr className="block">
              <td colSpan={3} className="block">
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconStart={<Plus aria-hidden />}
                    disabled={spans.length >= MAX_SPANS}
                    aria-label={`Add hours on ${DAY_NAME[day]}`}
                    onClick={() => {
                      replace(day, [...spans, nextSpan(spans)]);
                      setOpen({ day, at: spans.length });
                    }}
                  >
                    Add hours
                  </Button>
                  {closed ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconStart={<Copy aria-hidden />}
                      aria-label={`Copy ${DAY_NAME[day]} to ${target.label}`}
                      onClick={() => onChange(copyDay(hours, day))}
                    >
                      Copy to {target.label}
                    </Button>
                  )}
                </div>
                {editing !== null && spans[editing] ? (
                  <SpanEditor
                    day={day}
                    value={spans[editing]}
                    others={spans.filter((_, i) => i !== editing)}
                    onChange={(next) =>
                      replace(
                        day,
                        spans.map((s, i) => (i === editing ? next : s)),
                        `span:${mergeKey}:${day}:${editing}`,
                      )
                    }
                    onRemove={() => {
                      setOpen(null);
                      replace(
                        day,
                        spans.filter((_, i) => i !== editing),
                      );
                    }}
                    onDone={() => setOpen(null)}
                  />
                ) : null}
                {problem && editing === null ? (
                  <p role="alert" className="mt-1.5 text-xs text-danger">
                    {problem}
                  </p>
                ) : null}
              </td>
            </tr>
          </tbody>
        );
      })}
    </table>
  );
}
