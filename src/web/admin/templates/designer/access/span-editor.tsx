import { Trash2 } from 'lucide-react';
import { useId } from 'react';
import type { AccessDay } from '@/passkit/types.ts';
import { cn } from '../../../../lib/cn.ts';
import { Button, CheckboxField, CONTROL, CONTROL_HEIGHT, Label } from '../../../../ui/index.ts';
import { DAY_NAME, joinSpan, spanParts, spanProblem, spanText } from './hours.ts';

/** A clock field shows midnight at the end of a span as 00:00; the span keeps "24:00". */
const shown = (time: string) => (time === '24:00' ? '00:00' : time);

/**
 * The two times of one span, typed or picked. Each change applies at once: an overlap or an
 * empty span shows here and in the issues, and blocks saving until it is fixed.
 */
export function SpanEditor({
  day,
  value,
  others,
  onChange,
  onRemove,
  onDone,
}: {
  day: AccessDay;
  value: string;
  others: readonly string[];
  onChange: (span: string) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const { from, to } = spanParts(value);
  const allDay = value === '00:00-24:00';
  const problem = spanProblem(value);
  const clash = others.find((o) => o !== value && overlaps(o, value));
  const error = problem ?? (clash ? `Overlaps ${spanText(clash)}.` : null);
  const field = cn(CONTROL, CONTROL_HEIGHT, 'w-full tabular-nums');
  return (
    <fieldset className="ac-editor mt-2 grid min-w-0 gap-3 rounded-md border border-border bg-surface-sunken p-3">
      <legend className="sr-only">{DAY_NAME[day]} hours</legend>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col">
          <Label htmlFor={`${id}-from`} className="mb-1.5">
            From
          </Label>
          <input
            id={`${id}-from`}
            type="time"
            step={60}
            className={field}
            value={shown(from)}
            disabled={allDay}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => onChange(joinSpan(e.target.value, to))}
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
            value={shown(to)}
            disabled={allDay}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => onChange(joinSpan(from, e.target.value))}
          />
        </div>
      </div>
      <CheckboxField
        label="All day"
        checked={allDay}
        onCheckedChange={(on) => onChange(on === true ? '00:00-24:00' : '09:00-17:00')}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : (
        <p className="text-xs text-fg-muted">{spanText(value)}</p>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        <Button size="sm" variant="ghost" iconStart={<Trash2 aria-hidden />} onClick={onRemove}>
          Remove
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>
          Done
        </Button>
      </div>
    </fieldset>
  );
}

function overlaps(a: string, b: string): boolean {
  const range = (t: string): [number, number] | null => {
    const { from, to } = spanParts(t);
    const mins = (x: string) => {
      const [h = 0, m = 0] = x.split(':').map(Number);
      return h * 60 + m;
    };
    if (!/^\d\d:\d\d$/.test(from) || !/^\d\d:\d\d$/.test(to) || from === to) return null;
    const s = mins(from);
    const e = mins(to);
    return [s, e <= s ? e + 1440 : e];
  };
  const x = range(a);
  const y = range(b);
  return Boolean(x && y && x[0] < y[1] && y[0] < x[1]);
}
