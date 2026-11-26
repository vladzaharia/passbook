import { Search } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { BenchSlot } from './slots.tsx';
import './toolbar.css';

/** True while the person is typing: a field, a select or an editable region has focus. */
export const typing = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement &&
  !!el.closest(
    'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]',
  );

/**
 * The tool's search, first in the toolbar: 36 px (44 on touch), `/` focuses it from anywhere on the
 * page, Esc clears it. The value is the tool's (a query key through useBenchFilters).
 */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const slash = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    addEventListener('keydown', slash);
    return () => removeEventListener('keydown', slash);
  }, []);
  return (
    <label className="bench-search">
      <Search className="bench-search-i" aria-hidden="true" />
      <span className="sr">{label}</span>
      <input
        ref={input}
        type="search"
        value={value}
        placeholder={placeholder ?? label}
        aria-keyshortcuts="/"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || value === '') return;
          e.preventDefault();
          e.stopPropagation();
          onChange('');
        }}
      />
      <span className="bench-search-k" aria-hidden="true">
        /
      </span>
    </label>
  );
}

/**
 * The sticky toolbar under the bench head: the search first, then the filters (FilterBar), then
 * anything else; `note` (what the tool keeps, and for how long) is pushed to the end. Draws into the
 * frame's toolbar slot; outside the frame, in place.
 */
export function Toolbar({
  label,
  children,
  note,
}: {
  /** "Filter logs": the search landmark's name. */
  label: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <BenchSlot name="toolbar">
      <search className="bench-tb" aria-label={label}>
        {children}
        {note ? <span className="bench-tb-n">{note}</span> : null}
      </search>
    </BenchSlot>
  );
}
