import { useMemo, useState } from 'react';
import { MethodPill } from '../../ui/method-pill.tsx';
import type { RunIndex, RunIndexItem } from '../types.ts';

/** Every runnable operation by group, with a filter. A list of buttons: one tab stop, no widget to learn. */
export function Picker({
  index,
  current,
  onPick,
}: {
  index: RunIndex;
  current: string | null;
  onPick: (item: RunIndexItem) => void;
}) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return index.groups
      .map((g) => ({
        label: g.label,
        items: needle
          ? g.items.filter((i) => `${i.title} ${i.path} ${i.method}`.toLowerCase().includes(needle))
          : g.items,
      }))
      .filter((g) => g.items.length > 0);
  }, [index, q]);
  return (
    <nav className="picker" aria-label="Operations">
      <input
        type="search"
        placeholder="Find an operation"
        aria-label="Find an operation"
        value={q}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="picker-list">
        {groups.length === 0 ? <p className="muted sm">Nothing matches.</p> : null}
        {groups.map((g) => (
          <div key={g.label} className="stack">
            <h4>{g.label}</h4>
            {g.items.map((i) => (
              <button
                key={i.id}
                type="button"
                className="pick"
                aria-current={i.id === current ? 'true' : undefined}
                onClick={() => onPick(i)}
              >
                <span className="pick-t">{i.title}</span>
                <MethodPill method={i.method} />
              </button>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
