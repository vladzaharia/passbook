import { CircleAlert, CircleCheck, Copy, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../../model/highlight.ts';
import { copyToClipboard as copyText } from '../../shell/copy.ts';
import { CodeView } from '../../ui/code-view.tsx';
import { COPY_LANGS, copyAs } from '../copy-as.ts';
import { buildSent, type Draft, type InputCheck, inputUnchecked, problems } from '../request.ts';
import type { RunOp } from '../types.ts';
import { HeaderChips } from './chips.tsx';
import { FormTab } from './form.tsx';
import { JsonEditor } from './json-editor.tsx';

export type Tab = 'form' | 'json' | 'ts' | 'curl' | 'py' | 'go';
const TABS: { id: Tab; label: string }[] = [
  { id: 'form', label: 'Form' },
  { id: 'json', label: 'JSON' },
  ...COPY_LANGS.map((l) => ({ id: l.lang as Tab, label: l.label })),
];
const CONFIRM_MS = 4000;

interface Props {
  op: RunOp;
  origin: string;
  draft: Draft;
  /** The sandbox template's input schema, once read. */
  check?: InputCheck | undefined;
  tab: Tab;
  pending: boolean;
  spent: boolean;
  set: (next: Draft) => void;
  setTab: (t: Tab) => void;
  run: () => void;
  /** The Cmd/Ctrl+Enter path: the same gate as the button. */
  pressRef: { current: (() => void) | null };
}

/** The ticket stub: tabs, header chips, the editor and the Run button. */
export function Builder({
  op,
  origin,
  draft,
  check,
  tab,
  pending,
  spent,
  set,
  setTab,
  run,
  pressRef,
}: Props) {
  const [armed, setArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const issues = problems(op, draft, check);
  const tabs = TABS.filter((t) => t.id !== 'json' || op.body);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const blocked = issues.length > 0 || pending || spent;
  const press = () => {
    if (blocked) return;
    if (op.destructive && !armed) return setArmed(true);
    setArmed(false);
    run();
  };
  pressRef.current = press;
  const code = tab !== 'form' && tab !== 'json' ? copyAs(tab, buildSent(op, draft, origin)) : '';
  const move = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const next = tabs[(i + step + tabs.length) % tabs.length];
    if (!next) return;
    setTab(next.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return (
    <>
      <div className="code-h" role="tablist" aria-label="Request view" ref={list}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            className="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => move(e, i)}
          >
            {t.label}
          </button>
        ))}
        {code ? (
          <button
            type="button"
            className="iconbtn copy"
            aria-label={copied ? 'Copied' : 'Copy code'}
            data-state={copied ? 'copied' : undefined}
            onClick={() =>
              void copyText(code).then((ok) => {
                setCopied(ok);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            <Copy aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <HeaderChips op={op} draft={draft} set={set} />
      <div className="pane" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {tab === 'form' ? <FormTab op={op} draft={draft} issues={issues} set={set} /> : null}
        {tab === 'json' ? (
          <JsonEditor value={draft.body} onChange={(body) => set({ ...draft, body })} />
        ) : null}
        {code ? <CodeView code={code} lang={tab as Lang} label={`${tab} request`} /> : null}
      </div>
      <div className="runbar">
        <span className="valid" data-ok={issues.length === 0}>
          {issues.length === 0 ? (
            <>
              <CircleCheck aria-hidden="true" />
              {op.body
                ? inputUnchecked(op, draft, check)
                  ? 'Body shape valid'
                  : 'Valid against the schema'
                : 'Ready'}
            </>
          ) : (
            <details>
              <summary>
                <CircleAlert aria-hidden="true" />
                {issues.length === 1 ? '1 problem' : `${issues.length} problems`}
              </summary>
              <ul>
                {issues.slice(0, 8).map((i) => (
                  <li key={`${i.path}${i.message}`}>
                    <span className="mono">{i.path || 'body'}</span> {i.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </span>
        <button
          type="button"
          className={`btn run${armed ? ' danger' : ''}`}
          disabled={blocked}
          aria-busy={pending}
          onClick={press}
        >
          {pending ? <span className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
          {armed
            ? `Confirm ${op.method.toUpperCase()}`
            : pending
              ? 'Running'
              : spent
                ? 'Wait a moment'
                : 'Run'}
          {armed || pending ? null : (
            <span className="kbd" aria-hidden="true">
              ⌘↵
            </span>
          )}
        </button>
      </div>
    </>
  );
}
