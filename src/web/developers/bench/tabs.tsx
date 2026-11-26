import { type KeyboardEvent, useRef } from 'react';
import './inspector.css';

export interface BenchTab {
  id: string;
  label: string;
}

/** Tab and panel ids that point at each other. */
export const benchTabId = (base: string, id: string) => `${base}-t-${id}`;
export const benchPanelId = (base: string) => `${base}-p`;

const MOVE: Record<string, 1 | -1 | 'first' | 'last'> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  Home: 'first',
  End: 'last',
};

/**
 * The inspector's tabs (Request / Response, Headers / Body / Attempts / Verify): one Tab stop, the
 * arrows, Home and End move and select, each tab controls the one panel.
 */
export function BenchTabs({
  base,
  tabs,
  selected,
  onSelect,
  label,
}: {
  base: string;
  tabs: readonly BenchTab[];
  selected: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent, i: number) => {
    const by = MOVE[e.key];
    if (by === undefined) return;
    e.preventDefault();
    const at = by === 'first' ? 0 : by === 'last' ? tabs.length - 1 : i + by;
    const next = tabs[(at + tabs.length) % tabs.length];
    if (!next) return;
    onSelect(next.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return (
    <div className="bench-tabs" role="tablist" aria-label={label} ref={list}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={benchTabId(base, t.id)}
          data-tab={t.id}
          className="bench-tab"
          aria-selected={t.id === selected}
          aria-controls={benchPanelId(base)}
          tabIndex={t.id === selected ? 0 : -1}
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => move(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
