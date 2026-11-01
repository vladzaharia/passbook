import { Search, SlidersHorizontal, X } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../lib/cn.ts';
import { BELOW_XL, useMediaQuery } from '../lib/media.ts';
import { Button } from './button.tsx';
import { Input } from './input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';
import { Select, type SelectOption } from './select.tsx';

export interface FilterDef {
  id: string;
  /** "Status": the trigger reads "Status: Voided". */
  label: string;
  value: string;
  /** The value that means "not filtering" (usually "all" or "any"). */
  defaultValue: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
}

/** One range control for dates: "Date: any". Values are relative windows. */
export const DATE_RANGES: readonly SelectOption[] = [
  { value: 'any', label: 'any' },
  { value: '1d', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

/** The start (epoch ms) of a DATE_RANGES window, or undefined for "any". */
export function rangeStart(value: string, now: number): number | undefined {
  const days = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 }[value];
  return days ? now - days * 86_400_000 : undefined;
}

export interface FilterBarProps {
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  filters: readonly FilterDef[];
  onClear: () => void;
  className?: string;
}

function FilterSelect({ f, className }: { f: FilterDef; className?: string }) {
  return (
    <Select
      label={f.label}
      set={f.value !== f.defaultValue}
      value={f.value}
      onValueChange={f.onChange}
      options={f.options}
      className={cn('w-auto min-w-36 max-w-56', className)}
    />
  );
}

/**
 * The list toolbar: search, then "Label: value" selects (accent fill when set), then Clear. Below
 * 1280 the first two filters stay inline and the rest go in "Filters (n)"; below 640 search takes
 * the row and filters sit in two columns. A truly empty list hides it (DataTable toolbar).
 */
export function FilterBar({ search, filters, onClear, className }: FilterBarProps) {
  const id = useId();
  const compact = useMediaQuery(BELOW_XL);
  const inline = compact ? filters.slice(0, 2) : filters;
  const more = compact ? filters.slice(2) : [];
  const setCount = filters.filter((f) => f.value !== f.defaultValue).length;
  const moreSet = more.filter((f) => f.value !== f.defaultValue).length;
  const searching = Boolean(search?.value.trim());
  return (
    <search
      className={cn(
        'mb-3 flex flex-wrap items-center gap-2 max-sm:grid max-sm:grid-cols-2',
        className,
      )}
    >
      {search ? (
        <div className="relative max-sm:col-span-2 sm:w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted"
          />
          <Input
            id={`${id}-q`}
            type="search"
            aria-label={search.placeholder}
            placeholder={search.placeholder}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            className="pl-9"
          />
        </div>
      ) : null}
      {inline.map((f) => (
        <FilterSelect key={f.id} f={f} className="max-sm:w-full max-sm:max-w-none" />
      ))}
      {more.length ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              iconStart={<SlidersHorizontal aria-hidden />}
              className={cn(moreSet > 0 && 'border-accent bg-accent-subtle', 'max-sm:w-full')}
            >
              Filters{moreSet ? ` (${moreSet})` : ''}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-72 flex-col gap-3">
            {more.map((f) => (
              <FilterSelect key={f.id} f={f} className="w-full max-w-none" />
            ))}
            <div className="flex justify-end border-t border-border pt-3">
              <Button variant="ghost" size="sm" iconStart={<X aria-hidden />} onClick={onClear}>
                Clear
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      {setCount > 0 || searching ? (
        <Button variant="ghost" iconStart={<X aria-hidden />} onClick={onClear}>
          Clear
        </Button>
      ) : null}
    </search>
  );
}
