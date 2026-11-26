import { Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Lang } from '../../developers/model/highlight.ts';
import { CodeLines } from './code-lines.tsx';
import { copyToClipboard } from './copy.ts';
import { type CodeLang, LANGS } from './hash.ts';
import type { InputValues } from './model.ts';
import { changedLines, snippetsFor } from './snippets.ts';

const FLASH_MS = 1400;

/** Copies, then says "Copied" for a moment. `timer` holds the reset so unmounting can cancel it. */
async function copyAndSay(
  text: string,
  say: (on: boolean) => void,
  timer: { current: ReturnType<typeof setTimeout> | undefined; gone: boolean },
): Promise<void> {
  if (!(await copyToClipboard(text)) || timer.gone) return;
  say(true);
  clearTimeout(timer.current);
  timer.current = setTimeout(() => say(false), 1600);
}

/**
 * `POST /passes` for what is on screen, in four languages. The line an edit changed flashes; a
 * different template or language starts fresh, so only an edit marks anything.
 */
export function CodePanel({
  templateId,
  values,
  lang,
  onLang,
  apiBase,
}: {
  templateId: string;
  values: InputValues;
  lang: CodeLang;
  onLang: (l: CodeLang) => void;
  apiBase: string;
}) {
  const all = useMemo(
    () => snippetsFor(templateId, values, apiBase),
    [templateId, values, apiBase],
  );
  const current = all.find((s) => s.lang === lang) ?? all[0];
  const previous = useRef<{ key: string; code: string } | null>(null);
  const [changed, setChanged] = useState<ReadonlySet<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<{ current: ReturnType<typeof setTimeout> | undefined; gone: boolean }>({
    current: undefined,
    gone: false,
  });
  useEffect(() => {
    const timer = copyTimer.current;
    timer.gone = false;
    return () => {
      timer.gone = true;
      clearTimeout(timer.current);
    };
  }, []);
  const key = `${templateId}|${lang}`;
  const code = current?.code ?? '';
  useEffect(() => {
    const before = previous.current;
    previous.current = { key, code };
    if (!before || before.key !== key || before.code === code) return;
    setChanged(new Set(changedLines(before.code, code)));
    const t = setTimeout(() => setChanged(new Set()), FLASH_MS);
    return () => clearTimeout(t);
  }, [key, code]);
  return (
    <div className="code" data-testid="code-panel">
      <div className="code-h">
        <div role="tablist" aria-label="Language" style={{ display: 'contents' }}>
          {LANGS.map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              className="tab"
              aria-selected={l === lang}
              aria-current={l === lang ? 'true' : undefined}
              onClick={() => onLang(l)}
            >
              {all.find((s) => s.lang === l)?.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="iconbtn copy push"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => void copyAndSay(code, setCopied, copyTimer.current)}
        >
          <Copy aria-hidden="true" className="lucide" />
        </button>
      </div>
      <section className="region" aria-label={`${current?.label ?? ''} sample`}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code region */}
        <pre className="src num" tabIndex={0}>
          <code>
            <CodeLines code={code} lang={lang as Lang} changed={changed} />
          </code>
        </pre>
      </section>
    </div>
  );
}
