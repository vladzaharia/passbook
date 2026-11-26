import { Check, Copy } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cn } from '../../lib/cn.ts';
import { copyText } from '../../lib/clipboard.ts';
import { Button } from '../button.tsx';

/** "Endpoint URL" reads "endpoint URL" in a sentence; an acronym on its own stays. */
const lower = (s: string) =>
  /^[A-Z][a-z]/.test(s) ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s;

// "Copied" holds on a row until the next copy anywhere: one value is current at a time.
let last = '';
const subs = new Set<() => void>();
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
const mark = (key: string) => {
  last = key;
  for (const fn of subs) fn();
};

export interface CopyRowProps {
  /** Names the value: the row's label, and "Copy <label>" for the button. */
  label: string;
  value: string;
  /** "link" in the "Link copied" toast. Defaults to the lower-cased label. */
  what?: string;
  /** Show the label above the value. Off when a grid already labels it. */
  showLabel?: boolean;
  className?: string;
}

/** A value you paste elsewhere: mono, never wrapped, with a Copy that says "Copied" until the next copy. */
export function CopyRow({ label, value, what, showLabel = true, className }: CopyRowProps) {
  const key = `${label}\u0000${value}`;
  const copied = useSyncExternalStore(
    subscribe,
    () => last === key,
    () => false,
  );
  const row = (
    <div className="flex min-w-0 items-center gap-2">
      <input
        readOnly
        aria-label={label}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="block min-w-0 flex-1 truncate rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-xs text-fg-strong"
      />
      <Button
        variant="outline"
        size="sm"
        aria-label={copied ? `${label} copied` : `Copy ${lower(label)}`}
        iconStart={copied ? <Check aria-hidden className="wl-check" /> : <Copy aria-hidden />}
        onClick={() => void copyText(value, what ?? lower(label)).then((ok) => ok && mark(key))}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {showLabel ? <span className="text-sm font-medium text-fg">{label}</span> : null}
      {row}
    </div>
  );
}
