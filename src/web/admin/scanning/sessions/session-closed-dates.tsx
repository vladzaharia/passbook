import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { formatCalendarDate, todayKey } from '@/web/lib/format.ts';
import { Button, IconButton, Label } from '@/web/ui/index.ts';
import { CONTROL, CONTROL_HEIGHT } from '@/web/ui/input.tsx';
import { spanText } from '@/web/ui/week-grid/hours.ts';

const MAX_DATES = 60;

/** Closed dates, or special hours for a date, by the session's own calendar. */
export function ClosedDates({
  dates,
  timeZone,
  onChange,
}: {
  dates: Record<string, string[]> | undefined;
  timeZone: string;
  onChange: (dates: Record<string, string[]>) => void;
}) {
  const id = useId();
  const [date, setDate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const today = todayKey(timeZone);
  // Past dates stay in the draft; the server drops them on save.
  const sorted = Object.entries(dates ?? {})
    .filter(([key]) => key >= today)
    .sort(([a], [b]) => a.localeCompare(b));
  const partial = (from === '') !== (to === '');
  const same = from !== '' && from === to;
  const problem = partial
    ? 'Set both times, or neither.'
    : same
      ? 'End must differ from start.'
      : null;
  const exists = date in (dates ?? {});
  const full = !exists && Object.keys(dates ?? {}).length >= MAX_DATES;
  const past = date !== '' && date < today;
  const blocked = !date || Boolean(problem) || full || past;
  const add = () => {
    if (blocked) return;
    onChange({ ...dates, [date]: from && to ? [`${from}-${to}`] : [] });
    setDate('');
    setFrom('');
    setTo('');
  };
  const field = cn(CONTROL, CONTROL_HEIGHT, 'tabular-nums');
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-2 text-sm font-medium text-fg-strong">Dates</legend>
      {sorted.length > 0 ? (
        <ul className="grid gap-1">
          {sorted.map(([key, spans]) => (
            <li
              key={key}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
            >
              <span className="min-w-0">
                {formatCalendarDate(key)}
                <span className="text-fg-muted">
                  {' · '}
                  {spans.length === 0 ? 'Closed' : spans.map(spanText).join(', ')}
                </span>
              </span>
              <IconButton
                size="sm"
                label={`Remove ${formatCalendarDate(key)}`}
                icon={<X aria-hidden />}
                onClick={() => {
                  const { [key]: _gone, ...rest } = dates ?? {};
                  onChange(rest);
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[minmax(0,1.4fr)_1fr_1fr_auto]">
        <div className="col-span-2 flex flex-col sm:col-span-1">
          <Label htmlFor={`${id}-date`} className="mb-1.5">
            Date
          </Label>
          <input
            id={`${id}-date`}
            type="date"
            className={field}
            min={today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col">
          <Label htmlFor={`${id}-from`} className="mb-1.5">
            Open from
          </Label>
          <input
            id={`${id}-from`}
            type="time"
            step={60}
            className={field}
            value={from}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex flex-col">
          <Label htmlFor={`${id}-to`} className="mb-1.5">
            To
          </Label>
          <input
            id={`${id}-to`}
            type="time"
            step={60}
            className={field}
            value={to}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          className="col-span-2 sm:col-span-1"
          iconStart={<Plus aria-hidden />}
          disabled={blocked}
          onClick={add}
        >
          {exists ? 'Update' : 'Add'}
        </Button>
      </div>
      <p className="text-xs text-fg-muted">
        {problem ??
          (full
            ? `At most ${MAX_DATES} dates.`
            : past
              ? 'Pick today or later.'
              : exists
                ? 'This date is listed. Update replaces it.'
                : 'Closed days and special hours. No times closes the date all day.')}
      </p>
    </fieldset>
  );
}
