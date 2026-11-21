import { Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Lang } from '../model/highlight.ts';
import { CodeLines } from '../playground/code-lines.tsx';
import { copyToClipboard } from '../playground/copy.ts';
import { type CodeLang, LANGS } from '../playground/hash.ts';
import { type Code, litLines } from './model.ts';

const FILE = {
  create: { ts: 'create-pass.ts', curl: 'create-pass.sh', py: 'create_pass.py', go: 'main.go' },
  update: { ts: 'update-pass.ts', curl: 'update-pass.sh', py: 'update_pass.py', go: 'main.go' },
} satisfies Record<string, Record<CodeLang, string>>;
const NONE: ReadonlySet<number> = new Set();

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
        {LANGS.map((l) => (
          <button
            key={l}
            type="button"
            role="tab"
            className="tab"
            aria-selected={l === lang}
            onClick={() => onLang(l)}
          >
            {codes.find((c) => c.lang === l)?.label}
          </button>
        ))}
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
      <section className="region" aria-label={`${current?.label ?? ''} sample`}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code region */}
        <pre className="src num" tabIndex={0}>
          <code>
            <CodeLines code={code} lang={lang as Lang} changed={NONE} marked={marked} />
          </code>
        </pre>
      </section>
    </div>
  );
}
