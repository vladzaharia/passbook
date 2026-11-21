import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { WeeklyHours } from '@/passkit/types.ts';
import { formatCalendarDate, todayKey } from '@/web/lib/format.ts';
import {
  Button,
  DependentSettings,
  FormField,
  IconButton,
  Input,
  RadioGroup,
  SwitchRow,
  WeekGrid,
} from '@/web/ui/index.ts';
import type { Draft, HoursDraft } from '../draft.ts';
import type { StepProps } from './step-props.ts';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const MAX_CLOSED = 60;

function ClosedOn({
  dates,
  timeZone,
  onChange,
}: {
  dates: string[];
  timeZone: string;
  onChange: (dates: string[]) => void;
}) {
  const [date, setDate] = useState('');
  const today = todayKey(timeZone);
  const ok = date !== '' && date >= today && !dates.includes(date) && dates.length < MAX_CLOSED;
  const add = () => {
    if (!ok) return;
    onChange([...dates, date].sort());
    setDate('');
  };
  return (
    <div className="grid gap-2">
      <FormField label="Closed on">
        {(c) => (
          <div className="flex items-center gap-2">
            <Input
              {...c}
              type="date"
              min={today}
              value={date}
              className="max-w-48"
              onChange={(e) => setDate(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button variant="outline" iconStart={<Plus aria-hidden />} disabled={!ok} onClick={add}>
              Add date
            </Button>
          </div>
        )}
      </FormField>
      {dates.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {dates.map((d) => (
            <li
              key={d}
              className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface-raised py-0.5 pr-0.5 pl-3 text-sm"
            >
              {formatCalendarDate(d)}
              <IconButton
                size="sm"
                label={`Remove ${formatCalendarDate(d)}`}
                icon={<X aria-hidden />}
                onClick={() => onChange(dates.filter((x) => x !== d))}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Every day at the same span, or each day's own. */
function weekFrom(h: HoursDraft): WeeklyHours {
  const span = h.from && h.to ? [`${h.from}-${h.to}`] : [];
  return Object.fromEntries(DAYS.map((d) => [d, span]));
}

/** When: always open, or set hours. Turning hours on asks for them; it applies nothing. */
export function WhenStep({ draft, set }: StepProps) {
  const h = draft.hours;
  const patch = (p: Partial<HoursDraft>) => set({ hours: { ...h, ...p } } satisfies Partial<Draft>);
  return (
    <div className="grid gap-6">
      <RadioGroup
        legend="Open"
        value={h.mode}
        onValueChange={(mode) => patch({ mode: mode === 'set' ? 'set' : 'always' })}
        options={[
          { value: 'always', label: 'Always open' },
          { value: 'set', label: 'Set hours' },
        ]}
      />
      <DependentSettings open={h.mode === 'set'} className="gap-6">
        {h.split ? (
          <WeekGrid
            label="Door"
            mergeKey="setup-hours"
            hours={h.week}
            onChange={(week) => patch({ week })}
          />
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="Every day from">
              {(c) => (
                <Input
                  {...c}
                  type="time"
                  value={h.from}
                  className="w-36"
                  onChange={(e) => patch({ from: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="To">
              {(c) => (
                <Input
                  {...c}
                  type="time"
                  value={h.to}
                  className="w-36"
                  onChange={(e) => patch({ to: e.target.value })}
                />
              )}
            </FormField>
          </div>
        )}
        <SwitchRow
          label="Different on some days"
          checked={h.split}
          onCheckedChange={(split) =>
            patch({ split, week: split ? (h.week ?? weekFrom(h)) : h.week })
          }
        />
        <ClosedOn
          dates={h.closed}
          timeZone={draft.timeZone}
          onChange={(closed) => patch({ closed })}
        />
      </DependentSettings>
    </div>
  );
}
