import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { CODE_COPY } from '../../../shared/copy/developers-code.ts';
import { type CopyAsItem, CopyAsMenu } from './copy-as-menu.tsx';
import { CopyBtn, WrapToggle } from './copy-button.tsx';
import { SdkBadge } from './sdk-badge.tsx';

export interface HeaderTab {
  id: string;
  label: string;
  /** The SDK for this language is not published yet. */
  soon?: boolean;
}

/** Tab and panel ids that point at each other. */
export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string) => `${base}-panel`;

/**
 * The one header of an island's code block: a tablist that holds only tabs, then the file name, the SDK
 * badge for the open tab, Wrap (phones), one Copy and the Copy as menu. Copy sits outside the tablist.
 */
export function CodeHeader({
  base,
  tabs,
  selected,
  onSelect,
  file,
  copyText,
  copyLabel,
  items,
  onCopied,
}: {
  base: string;
  tabs: readonly HeaderTab[];
  selected: string;
  onSelect: (id: string) => void;
  file?: string;
  copyText: string;
  copyLabel?: string;
  items?: CopyAsItem[];
  onCopied?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const current = tabs.find((t) => t.id === selected);
  const move = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const next = tabs[(i + step + tabs.length) % tabs.length];
    if (!step || !next) return;
    e.preventDefault();
    onSelect(next.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  const tools: ReactNode = (
    <>
      {file || current?.soon ? (
        <span className="code-meta">
          {file ? <span className="file">{file}</span> : null}
          {current?.soon ? <SdkBadge lang={current.id} /> : null}
        </span>
      ) : null}
      <WrapToggle />
      <CopyBtn text={copyText} label={copyLabel} onCopied={onCopied} />
      {items && items.length > 0 ? <CopyAsMenu items={items} /> : null}
    </>
  );
  return (
    <div className="code-h">
      <div className="tabs" role="tablist" aria-label={CODE_COPY.language} ref={list}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={tabId(base, t.id)}
            data-tab={t.id}
            className="tab"
            aria-selected={t.id === selected}
            aria-controls={panelId(base)}
            tabIndex={t.id === selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => move(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="code-tools">{tools}</div>
    </div>
  );
}

/** Markdown for the Copy as menu: the open sample, fenced. */
export const fenced = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;
