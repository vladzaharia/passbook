import { type KeyboardEvent, useRef } from 'react';

/** The portal's segmented control as a radiogroup: arrows move and select, one tab stop. */
export function Seg<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const at = options.findIndex((o) => o.value === value);
    const next = options[(at + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[options.indexOf(next)]?.focus();
  };
  return (
    <div
      ref={group}
      className={className ? `seg ${className}` : 'seg'}
      role="radiogroup"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={move}
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented radiogroup, as the kit's
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
