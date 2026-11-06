import { type CSSProperties, type Ref, useState } from 'react';
import { cn } from '../lib/cn.ts';
import './code-field.css';

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
  /** Characters in the code. Default 6. */
  length?: number;
  /** Slots per group, for the gap (3 gives 123 456; 5 gives K7QH2 M9XTR). Default 3. */
  group?: number;
  /** `digits` (default) or Crockford base32, as in scanner pairing codes. */
  alphabet?: 'digits' | 'crockford';
}

/** Keeps digits only, at most six (pasting "123 456" works). */
export const codeDigits = (raw: string) => raw.replace(/\D/g, '').slice(0, CODE_LENGTH);

/** Crockford base32: upper-case, I and L read as 1, O as 0, no U, separators dropped. */
export const crockfordCode = (raw: string, length: number) =>
  raw
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
    .slice(0, length);

function samePrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * A short code (the 6-digit sign-in code, a 10-character pairing code): one large mono field, grouped. The real input carries the
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
  length = CODE_LENGTH,
  group = 3,
  alphabet = 'digits',
}: CodeFieldProps) {
  const crockford = alphabet === 'crockford';
  const normalise = (raw: string) =>
    crockford ? crockfordCode(raw, length) : codeDigits(raw).slice(0, length);
  // Digits from the last change pop; several at once (paste, autofill) pop 30 ms apart.
  const [change, setChange] = useState({ from: length, n: 0 });
  return (
    <div className="wl-code" data-complete={value.length === length ? '' : undefined}>
      <input
        id={id}
        ref={inputRef}
        value={value}
        onChange={(e) => {
          const next = normalise(e.target.value);
          setChange((c) => ({ from: samePrefix(value, next), n: c.n + 1 }));
          onChange(next);
        }}
        onBlur={onBlur}
        inputMode={crockford ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        pattern={crockford ? '[0-9A-Za-z]*' : '[0-9]*'}
        autoCapitalize={crockford ? 'characters' : undefined}
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'wl-code-input h-14 w-full min-w-0 rounded-md border border-border-strong bg-(--wl-field) wl-colors',
          // The text is transparent (the slots draw it), but iOS zooms into any field under 16 px.
          'hover:not-disabled:border-fg-muted aria-[invalid=true]:border-danger pointer-coarse:text-[max(16px,1rem)]',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        )}
      />
      <span aria-hidden className="wl-code-slots">
        {Array.from({ length }, (_, i) => {
          const digit = value[i];
          const fresh = digit !== undefined && i >= change.from;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its position
              key={i}
              className="wl-code-slot"
              data-caret={i === value.length ? '' : undefined}
              data-group-start={i > 0 && i % group === 0 ? '' : undefined}
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
