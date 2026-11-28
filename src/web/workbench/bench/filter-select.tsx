import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { Sheet } from '../../developers/ui/sheet.tsx';
import { cn } from '../../lib/cn.ts';
import { useMediaQuery } from '../../lib/media.ts';
import { Button } from '../../ui/button.tsx';
import { BENCH_TABLET } from './split.tsx';
import './toolbar.css';

const C = BENCH_COPY.toolbar;

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * One filter: "Status  Any ▾" over a native select (the phone's own picker, the keyboard's own
 * keys). Set, it fills with the accent's quiet tint and its value turns 500.
 */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  any = C.any,
  className,
}: {
  label: string;
  /** '' or undefined: off. */
  value: string | undefined;
  options: readonly FilterOption[];
  onChange: (value: string | null) => void;
  /** The off choice's words. */
  any?: string;
  /** A tool's hook for its own sizing (the phone toolbar). */
  className?: string;
}) {
  const shown = options.find((o) => o.value === value)?.label ?? any;
  return (
    <label
      className={className ? `bench-fs ${className}` : 'bench-fs'}
      data-set={value ? '' : undefined}
    >
      <span className="bench-fs-l">{label}</span>
      <span className="bench-fs-v">{shown}</span>
      <ChevronDown className="bench-fs-c" aria-hidden="true" />
      <select
        className="bench-fs-s"
        value={value ?? ''}
        aria-label={label}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">{any}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The filters of a toolbar. From 720 px they sit in the row, with Clear once one is set. Below, the
 * row keeps only "Filters (n)", which opens them in a bottom sheet with Clear and Done.
 */
export function FilterBar({
  active,
  onClear,
  children,
}: {
  /** How many are set (useBenchFilters). */
  active: number;
  onClear: () => void;
  /** FilterSelects. */
  children: ReactNode;
}) {
  const wide = useMediaQuery(BENCH_TABLET);
  const [open, setOpen] = useState(false);
  const clear =
    active > 0 ? (
      <button type="button" className="btn ghost sm bench-fb-x" onClick={onClear}>
        {C.clear}
      </button>
    ) : null;
  if (wide)
    return (
      <div className="bench-fb">
        {children}
        {clear}
      </div>
    );
  return (
    <>
      <Button
        variant="outline"
        iconStart={<SlidersHorizontal aria-hidden />}
        className={cn('shrink-0', active > 0 && 'border-accent bg-accent-subtle')}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {C.count(active)}
      </Button>
      {open ? (
        <Sheet
          title={C.filters}
          onClose={() => setOpen(false)}
          footer={
            <>
              {clear}
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                {C.done}
              </button>
            </>
          }
        >
          <div className="bench-fb bench-fb-sheet">{children}</div>
        </Sheet>
      ) : null}
    </>
  );
}
