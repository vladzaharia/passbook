import { ChevronDown, X } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/web/lib/cn.ts';
import {
  Button,
  CONTROL,
  CONTROL_HEIGHT,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  rangeStart,
} from '@/web/ui/index.ts';
import { dayToMs, msToDay, rangeLabel } from './audit-search.ts';

const QUICK = [
  { value: '1d', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
] as const;

/** One range control, "Date: any": quick windows, then From and To days. */
export function DateFilter({
  from,
  to,
  onChange,
  className,
}: {
  from: number | undefined;
  to: number | undefined;
  onChange: (next: { from: number | undefined; to: number | undefined }) => void;
  className?: string;
}) {
  const id = useId();
  const set = from !== undefined || to !== undefined;
  const value = rangeLabel(from, to);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Date: ${value}`}
        className={cn(
          CONTROL,
          CONTROL_HEIGHT,
          'flex items-center justify-between gap-2 whitespace-nowrap text-left',
          set && 'border-accent bg-accent-subtle text-fg-strong',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-fg-muted">Date:</span>
          <span className="min-w-0 truncate">{value}</span>
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-72 flex-col gap-4">
        <div className="grid grid-cols-4 gap-1">
          {QUICK.map((q) => (
            <Button
              key={q.value}
              variant="outline"
              size="sm"
              className="px-2"
              onClick={() => onChange({ from: rangeStart(q.value, Date.now()), to: undefined })}
            >
              {q.label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-from`}>From</Label>
            <Input
              id={`${id}-from`}
              type="date"
              value={msToDay(from)}
              max={msToDay(to) || undefined}
              onChange={(e) => onChange({ from: dayToMs(e.target.value, false), to })}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-to`}>To</Label>
            <Input
              id={`${id}-to`}
              type="date"
              value={msToDay(to)}
              min={msToDay(from) || undefined}
              onChange={(e) => onChange({ from, to: dayToMs(e.target.value, true) })}
            />
          </div>
        </div>
        {set ? (
          <div className="flex justify-end border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              iconStart={<X aria-hidden />}
              onClick={() => onChange({ from: undefined, to: undefined })}
            >
              Any date
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
