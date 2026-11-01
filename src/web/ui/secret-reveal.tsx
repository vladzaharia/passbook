import { Eye, EyeOff } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { Button } from './button.tsx';
import { Callout } from './callout.tsx';
import { CheckboxField } from './checkbox.tsx';
import { CopyButton } from './copy-button.tsx';
import { IconButton } from './icon-button.tsx';
import { Tooltip } from './tooltip.tsx';

export interface SecretField {
  label: string;
  value: string;
  /** Masked until Show (default true). */
  secret?: boolean;
  /** The copy button's name when "Copy <label>" reads wrong: "Copy endpoint URL". */
  copyLabel?: string;
  /** Catches the foil sheen (default true); one sheen per reveal reads best. */
  sheen?: boolean;
}

/** "abcdefghij…uvwxyz" for long values; the full value is in the tooltip. */
export function middle(value: string, keep = 12): string {
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

/** A labelled value with Show and Copy in their own columns. */
export function CopyField({ label, value, secret = true, copyLabel, sheen = true }: SecretField) {
  const id = useId();
  const [shown, setShown] = useState(!secret);
  const text = shown ? middle(value) : '•'.repeat(Math.min(24, Math.max(12, value.length)));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span id={id} className="text-sm font-medium text-fg">
        {label}
      </span>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1">
        <Tooltip content={shown && text !== value ? value : undefined}>
          <output
            aria-labelledby={id}
            className={cn(
              'relative block min-w-0 overflow-hidden truncate rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-xs text-fg-strong',
              sheen && 'wl-sheen-once',
            )}
          >
            {shown ? (
              text
            ) : (
              <>
                <span className="sr-only">Hidden</span>
                <span aria-hidden>{text}</span>
              </>
            )}
          </output>
        </Tooltip>
        {secret ? (
          <IconButton
            label={shown ? `Hide ${label}` : `Show ${label}`}
            size="sm"
            icon={shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            onClick={() => setShown((s) => !s)}
          />
        ) : (
          <span />
        )}
        <CopyButton value={value} label={copyLabel ?? `Copy ${label}`} />
      </div>
    </div>
  );
}

/**
 * A secret shown once: a warning, labelled masked fields with Copy, and "I saved the secret"
 * gating Done. The body turns in once and each value catches one foil sheen.
 */
export function SecretReveal({
  fields,
  onDone,
  doneLabel = 'Done',
  savedLabel = 'I saved the secret',
  children,
  className,
}: {
  fields: readonly SecretField[];
  onDone: () => void;
  doneLabel?: string;
  /** The checkbox that gates Done: "I saved the key". */
  savedLabel?: string;
  /** Extra content under the fields (an example request). */
  children?: ReactNode;
  className?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <div className={cn('wl-turn flex flex-col gap-4', className)}>
      <Callout tone="warning">Copy the secret now. It is not shown again.</Callout>
      {fields.map((f) => (
        <CopyField key={f.label} {...f} />
      ))}
      {children}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CheckboxField
          label={savedLabel}
          checked={saved}
          onCheckedChange={(v) => setSaved(v === true)}
        />
        <Button disabled={!saved} onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
