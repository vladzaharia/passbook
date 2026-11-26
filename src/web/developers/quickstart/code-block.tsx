import { useMemo, useState } from 'react';
import { CODE_COPY } from '../../../shared/copy/developers-code.ts';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import type { Lang } from '../model/highlight.ts';
import { CodeLines } from '../playground/code-lines.tsx';
import type { CodeLang } from '../playground/hash.ts';
import { CodeHeader, fenced, type HeaderTab, panelId, tabId } from '../ui/code-header.tsx';
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
const CLI = 'cli';

/** The request in four languages. The lines that carry your input stay lit; the language you pick holds for the page. */
export function CodeBlock({
  codes,
  lang,
  onLang,
  lit,
  base,
  name,
  onCopy,
}: {
  codes: Code[];
  lang: CodeLang;
  onLang: (l: CodeLang) => void;
  lit: readonly string[];
  base: keyof typeof FILE;
  /** Makes the region's label unique on a page with several blocks. */
  name: string;
  onCopy?: () => void;
}) {
  const [cli, setCli] = useState(false);
  const current = codes.find((c) => c.lang === lang) ?? codes[0];
  const code = current?.code ?? '';
  const marked = useMemo(() => litLines(code, lit), [code, lit]);
  const tabs: HeaderTab[] = ORDER.map((l) => ({
    id: l,
    label: codes.find((c) => c.lang === l)?.label ?? l,
    soon: !PUBLISHED[l],
  }));
  if (!SDK_STATUS.cli) tabs.push({ id: CLI, label: QS_COPY.call.cli, soon: true });
  const id = `qs-${base}`;
  return (
    <div className="code qs-code">
      <CodeHeader
        base={id}
        tabs={tabs}
        selected={cli ? CLI : lang}
        onSelect={(t) => {
          setCli(t === CLI);
          if (t !== CLI) onLang(t as CodeLang);
        }}
        file={cli ? undefined : FILE[base][lang]}
        copyText={cli ? QS_COPY.call.cliLine : code}
        onCopied={onCopy}
        items={[
          ...codes.map((c) => ({ key: c.lang, label: c.label, text: () => c.code })),
          {
            key: 'md',
            label: CODE_COPY.markdown,
            text: () => fenced(lang === 'curl' ? 'bash' : lang, code),
          },
        ]}
      />
      <div role="tabpanel" id={panelId(id)} aria-labelledby={tabId(id, cli ? CLI : lang)}>
        {cli ? (
          <p className="qs-soon-line sm muted">{QS_COPY.call.cliLine}</p>
        ) : (
          <section className="region" aria-label={`${name}: ${current?.label ?? ''} sample`}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code region */}
            <pre className="src num" tabIndex={0}>
              <code>
                <CodeLines code={code} lang={lang as Lang} changed={NONE} marked={marked} />
              </code>
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
