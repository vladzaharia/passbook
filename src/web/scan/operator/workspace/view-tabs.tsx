import { type KeyboardEvent, useRef } from 'react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import type { OperatorView } from '../keys.ts';

export const tabId = (view: OperatorView) => `op-tab-${view}`;
export const panelId = 'op-panel';

/** The list views as tabs. Arrows move between them; a count shows when there is something to act on. */
export function ViewTabs({
  views,
  view,
  counts,
  onChange,
}: {
  views: readonly OperatorView[];
  view: OperatorView;
  counts: Partial<Record<OperatorView, number>>;
  onChange: (view: OperatorView) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const at = views.indexOf(view);
    const next = views[(at + step + views.length) % views.length];
    if (!next) return;
    e.preventDefault();
    onChange(next);
    root.current?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus();
  };
  return (
    <div
      ref={root}
      role="tablist"
      aria-label={OPERATOR_COPY.landmark.tabs}
      className="op-tabs"
      onKeyDown={onKeyDown}
    >
      {views.map((v, index) => {
        const n = counts[v];
        return (
          <button
            key={v}
            id={tabId(v)}
            type="button"
            role="tab"
            aria-selected={v === view}
            aria-controls={panelId}
            aria-keyshortcuts={`Alt+${index + 1}`}
            tabIndex={v === view ? 0 : -1}
            className="op-tab"
            onClick={() => onChange(v)}
          >
            {OPERATOR_COPY.tabs[v]}
            {n ? (
              <span className="op-count" data-tone={v === 'problems' ? 'alert' : undefined}>
                {n}
                {v === 'problems' ? <span className="sr-only"> need you</span> : null}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
