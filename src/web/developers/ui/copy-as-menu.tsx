import { ChevronDown } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { COPY_LANGS, type CopyLang, copyAs, type Sent } from '../console/copy-as.ts';
import { copyToClipboard as copyText } from '../shell/copy.ts';

/** "Copy as" in four languages: the exact request that ran, with `$PASSBOOK_KEY` where the key goes. */
export function CopyAsMenu({ sent }: { sent: Sent }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const pick = async (lang: CopyLang, label: string) => {
    setOpen(false);
    setDone((await copyText(copyAs(lang, sent))) ? `Copied as ${label}` : 'Could not copy');
    setTimeout(() => setDone(null), 1800);
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
        {done ?? 'Copy as'}
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? (
        <div className="menu-list" role="menu" id={id}>
          {COPY_LANGS.map((l) => (
            <button
              key={l.lang}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => void pick(l.lang, l.label)}
            >
              {l.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
