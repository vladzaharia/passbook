import { Copy } from 'lucide-react';
import { useState } from 'react';
import { CodeView } from '../ui/code-view.tsx';
import type { VerifySample } from './samples.ts';

/** Language tabs, one panel at a time; the portal's copy handler reads the visible lines. */
export function Samples({ samples }: { samples: readonly VerifySample[] }) {
  const [current, setCurrent] = useState(samples[0]?.id);
  const shown = samples.find((s) => s.id === current) ?? samples[0];
  if (!shown) return null;
  return (
    <div className="code">
      <div className="code-h" role="tablist" aria-label="Language">
        {samples.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            className="tab wh-lang"
            aria-selected={s.id === shown.id}
            onClick={() => setCurrent(s.id)}
          >
            {s.label}
          </button>
        ))}
        <button type="button" className="iconbtn copy" data-copy aria-label="Copy sample">
          <Copy className="lucide" aria-hidden="true" />
        </button>
      </div>
      <div className="panel" data-panel={shown.id}>
        <CodeView code={shown.code} lang={shown.lang} label={`${shown.label} sample`} num />
      </div>
    </div>
  );
}
