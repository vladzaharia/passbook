import { type CSSProperties, type Ref, useState } from 'react';
import { cn } from '../lib/cn.ts';

export const CODE_LENGTH = 6;

export interface CodeFieldProps {
  id: string;
  value: string;
  onChange: (digits: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  describedBy?: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
}

/** Keeps digits only, at most six (pasting "123 456" works). */
export const codeDigits = (raw: string) => raw.replace(/\D/g, '').slice(0, CODE_LENGTH);

function samePrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * The 6-digit sign-in code: one large mono field, grouped 123 456. The real input carries the
 * value (autofill, paste, screen readers); the slots over it are decoration, so each digit can
 * pop as it arrives and the field glows once when complete.
 */
export function CodeField({
  id,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
  inputRef,
  disabled,
}: CodeFieldProps) {
  // Digits from the last change pop; several at once (paste, autofill) pop 30 ms apart.
  const [change, setChange] = useState({ from: CODE_LENGTH, n: 0 });
  return (
    <div className="wl-code" data-complete={value.length === CODE_LENGTH ? '' : undefined}>
      <input
        id={id}
        ref={inputRef}
        value={value}
        onChange={(e) => {
          const next = codeDigits(e.target.value);
          setChange((c) => ({ from: samePrefix(value, next), n: c.n + 1 }));
          onChange(next);
        }}
        onBlur={onBlur}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'wl-code-input h-14 w-full min-w-0 rounded-md border border-border-strong bg-(--wl-field) wl-colors',
          'hover:not-disabled:border-fg-muted aria-[invalid=true]:border-danger',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        )}
      />
      <span aria-hidden className="wl-code-slots">
        {Array.from({ length: CODE_LENGTH }, (_, i) => {
          const digit = value[i];
          const fresh = digit !== undefined && i >= change.from;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its position
              key={i}
              className="wl-code-slot"
              data-caret={i === value.length ? '' : undefined}
            >
              {digit === undefined ? null : (
                <span
                  key={fresh ? `${digit}-${change.n}` : digit}
                  className={fresh ? 'wl-code-digit' : undefined}
                  style={fresh ? ({ '--i': i - change.from } as CSSProperties) : undefined}
                >
                  {digit}
                </span>
              )}
            </span>
          );
        })}
      </span>
    </div>
  );
}
