import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { usePaneShape } from './split.tsx';
import { type BenchTab, BenchTabs, benchPanelId, benchTabId } from './tabs.tsx';
import './inspector.css';

const C = BENCH_COPY.inspector;

/**
 * The selected item, in the pane WB1's grid gives it: a sticky side pane from 1180 px, a drawer from
 * 720, a bottom sheet below (BenchSplit with `bare`). The header's first line is the title (mono) and,
 * in a drawer or sheet, Previous, Next and Close; its second the status, the IdChip and the actions.
 * Then the facts, the tabs, the body (a focusable region that fades in when the item changes) and
 * the Trace.
 * `[` and `]` step through the list from anywhere inside it.
 */
export function Inspector({
  title,
  label,
  itemKey,
  status,
  id,
  actions,
  facts,
  tabs,
  tab,
  onTab,
  onPrev,
  onNext,
  trace,
  children,
}: {
  title: ReactNode;
  /** The pane's and the body's name, in words ("Request GET /passes"). */
  label: string;
  /** The item's id: a new one replays the body's entrance. */
  itemKey: string;
  status?: ReactNode;
  id?: ReactNode;
  actions?: ReactNode;
  /** One quiet line under the header (time, duration, key). */
  facts?: ReactNode;
  tabs?: readonly BenchTab[];
  tab?: string;
  onTab?: (id: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  trace?: ReactNode;
  children: ReactNode;
}) {
  const base = useId().replace(/:/g, '');
  const { shape, close } = usePaneShape();
  const floating = shape !== 'side';
  const tabbed = tabs && tabs.length > 0 && tab !== undefined && onTab;
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      t.closest('input, textarea, select, [contenteditable]')
    )
      return;
    if (e.key === '[' && onPrev) onPrev();
    else if (e.key === ']' && onNext) onNext();
    else return;
    e.preventDefault();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: [ and ] reach the list from any control inside
    <div className="bench-insp" data-shape={shape} onKeyDown={onKey}>
      <header className="bench-insp-h">
        <div className="bench-insp-top">
          {/* Focus lands on the title when a drawer or sheet opens (split.tsx): it is read first. */}
          <h2 className="bench-insp-t" tabIndex={-1} data-pane-focus="">
            {title}
          </h2>
          {floating ? (
            <span className="bench-insp-nav">
              {onPrev || onNext ? (
                <>
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={C.prev}
                    aria-keyshortcuts="["
                    title={`${C.prev} ([)`}
                    disabled={!onPrev}
                    onClick={onPrev}
                  >
                    <ChevronUp aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={C.next}
                    aria-keyshortcuts="]"
                    title={`${C.next} (])`}
                    disabled={!onNext}
                    onClick={onNext}
                  >
                    <ChevronDown aria-hidden="true" />
                  </button>
                </>
              ) : null}
              {close ? (
                <button
                  type="button"
                  className="iconbtn"
                  aria-label={C.close}
                  aria-keyshortcuts="Escape"
                  onClick={close}
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
        {status || id || actions ? (
          <div className="bench-insp-meta">
            {status ? <span className="bench-insp-s">{status}</span> : null}
            {id ? <span className="bench-insp-id">{id}</span> : null}
            {actions ? <span className="bench-insp-a">{actions}</span> : null}
          </div>
        ) : null}
      </header>
      {facts ? <div className="bench-insp-f">{facts}</div> : null}
      {tabbed ? (
        <BenchTabs base={base} tabs={tabs} selected={tab} onSelect={onTab} label={label} />
      ) : null}
      <div
        key={`${itemKey}|${tab ?? ''}`}
        className="bench-insp-b"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the body scrolls; the keyboard reaches it
        tabIndex={0}
        {...(tabbed
          ? { role: 'tabpanel', id: benchPanelId(base), 'aria-labelledby': benchTabId(base, tab) }
          : { role: 'region', 'aria-label': label })}
      >
        {children}
      </div>
      {trace ? <footer className="bench-insp-tr">{trace}</footer> : null}
    </div>
  );
}
