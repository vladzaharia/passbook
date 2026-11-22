import { Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import type { Lang } from '../model/highlight.ts';
import { CodeLines } from '../playground/code-lines.tsx';
import { copyToClipboard } from '../playground/copy.ts';
import type { CodeLang } from '../playground/hash.ts';
import { type Code, litLines } from './model.ts';

const FILE = {
  create: { ts: 'create-pass.ts', curl: 'create-pass.sh', py: 'create_pass.py', go: 'main.go' },
  update: { ts: 'update-pass.ts', curl: 'update-pass.sh', py: 'update_pass.py', go: 'main.go' },
} satisfies Record<string, Record<CodeLang, string>>;
const NONE: ReadonlySet<number> = new Set();
/** curl first: it is the one request that runs today, whatever is published. */
const ORDER: readonly CodeLang[] = ['curl', 'ts', 'py', 'go'];
const PUBLISHED: Record<CodeLang, boolean> = {
  curl: true,
  ts: SDK_STATUS.typescript,
  py: SDK_STATUS.python,
  go: SDK_STATUS.go,
};

/** The request in four languages. The lines that carry your input stay lit; the language you pick holds for the page. */
export function CodeBlock({
  codes,
  lang,
  onLang,
  lit,
  base,
  onCopy,
}: {
  codes: Code[];
  lang: CodeLang;
  onLang: (l: CodeLang) => void;
  lit: readonly string[];
  base: keyof typeof FILE;
  onCopy?: () => void;
}) {
  const [cli, setCli] = useState(false);
  const current = codes.find((c) => c.lang === lang) ?? codes[0];
  const code = current?.code ?? '';
  const marked = useMemo(() => litLines(code, lit), [code, lit]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyToClipboard(code))) return;
    setCopied(true);
    onCopy?.();
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="code qs-code">
      <div className="code-h" role="tablist" aria-label="Language">
        {ORDER.map((l) => (
          <button
            key={l}
            type="button"
            role="tab"
            className="tab"
            aria-selected={!cli && l === lang}
            onClick={() => {
              setCli(false);
              onLang(l);
            }}
          >
            {codes.find((c) => c.lang === l)?.label}
            {PUBLISHED[l] ? null : (
              <span className="qs-soon" role="img" aria-label="Not published yet" />
            )}
          </button>
        ))}
        {SDK_STATUS.cli ? null : (
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={cli}
            onClick={() => setCli(true)}
          >
            {QS_COPY.call.cli}
            <span className="qs-soon" role="img" aria-label="Not published yet" />
          </button>
        )}
        <span className="file push">{FILE[base][lang]}</span>
        <button
          type="button"
          className="iconbtn copy"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => void copy()}
        >
          <Copy aria-hidden="true" className="lucide" />
        </button>
      </div>
      {cli ? (
        <p className="qs-soon-line sm muted">{QS_COPY.call.cliLine}</p>
      ) : (
        <section className="region" aria-label={`${current?.label ?? ''} sample`}>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code region */}
          <pre className="src num" tabIndex={0}>
            <code>
              <CodeLines code={code} lang={lang as Lang} changed={NONE} marked={marked} />
            </code>
          </pre>
        </section>
      )}
      {!cli && current && !PUBLISHED[current.lang] ? (
        <p className="qs-soon-line xs muted">{QS_COPY.call.soon}</p>
      ) : null}
    </div>
  );
}
