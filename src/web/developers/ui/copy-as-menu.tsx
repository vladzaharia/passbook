import { ChevronDown } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { CODE_COPY } from '../../../shared/copy/developers-code.ts';
import { copyWithFeedback } from '../shell/copy.ts';

export interface CopyAsItem {
  key: string;
  label: string;
  /** Read when picked, so a menu never holds a stale sample. */
  text: () => string;
}

/** "Copy as" for an island: one item per language, plus whatever the caller adds (Markdown). */
export function CopyAsMenu({ items }: { items: CopyAsItem[] }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const pick = (item: CopyAsItem) => {
    setOpen(false);
    const button = root.current?.closest('.code')?.querySelector<HTMLElement>('.copy') ?? null;
    // Inside a block the Copy button shows the check; elsewhere this button says what happened.
    void copyWithFeedback(item.text(), button).then((ok) => {
      if (button) return;
      setDone(ok ? CODE_COPY.copiedAs(item.label) : CODE_COPY.copyFailed);
      setTimeout(() => setDone(null), 1800);
    });
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape and focus-out close the menu; the buttons inside are the controls
    <div
      className="menu"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setOpen(false);
          root.current?.querySelector('button')?.focus();
        }
      }}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="btn ghost sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {done ?? CODE_COPY.copyAs}
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? (
        <div className="menu-list" role="menu" id={id}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => pick(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
