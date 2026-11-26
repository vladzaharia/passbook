import { useEffect, useState } from 'react';
import { CODE_COPY } from '../../../shared/copy/developers-code.ts';
import { onLang, savedLang, setLang } from '../shell/language.ts';
import { CodeHeader, fenced, panelId, tabId } from '../ui/code-header.tsx';
import { CodeView } from '../ui/code-view.tsx';
import type { VerifySample } from './samples.ts';

const BASE = 'wh-verify';

/** Language tabs, one panel at a time. The language you picked last, here or on another page, opens first. */
export function Samples({ samples }: { samples: readonly VerifySample[] }) {
  const has = (id: string | null) => samples.some((s) => s.id === id);
  const [current, setCurrent] = useState<string | undefined>(() => {
    const saved = savedLang();
    return has(saved) ? (saved ?? undefined) : samples[0]?.id;
  });
  useEffect(() => onLang((l) => has(l) && setCurrent(l)));
  const shown = samples.find((s) => s.id === current) ?? samples[0];
  if (!shown) return null;
  return (
    <div className="code">
      <CodeHeader
        base={BASE}
        tabs={samples}
        selected={shown.id}
        onSelect={(id) => {
          setCurrent(id);
          // Only the languages every block shares are remembered; node and openssl are this page's.
          if (id === 'ts' || id === 'py' || id === 'go') setLang(id);
        }}
        copyText={shown.code}
        items={[
          ...samples.map((s) => ({ key: s.id, label: s.label, text: () => s.code })),
          { key: 'md', label: CODE_COPY.markdown, text: () => fenced(shown.lang, shown.code) },
        ]}
      />
      <div role="tabpanel" id={panelId(BASE)} aria-labelledby={tabId(BASE, shown.id)}>
        <CodeView code={shown.code} lang={shown.lang} label={`Verify: ${shown.label} sample`} num />
      </div>
    </div>
  );
}
