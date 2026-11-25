import { Copy } from 'lucide-react';
import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { highlight, type Lang } from '../model/highlight.ts';
import type { Sample } from '../model/samples.ts';

/** A static, focusable code region: a labelled section that scrolls, holding the highlighted lines. */
export function CodeRegion({ html, label, num }: { html: string; label: string; num?: boolean }) {
  return (
    <section className="region" aria-label={label}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code region */}
      <pre className={`src${num ? ' num' : ''}`} tabIndex={0}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted at build from the repo's own spec, escaped per token */}
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </section>
  );
}

export function CopyButton({ label }: { label: string }) {
  return (
    <button type="button" className="iconbtn copy" data-copy aria-label={label}>
      <Copy className="lucide" aria-hidden="true" />
    </button>
  );
}

/**
 * Language tabs without script: radios and labels, the panel shown by :has(:checked). The island
 * keeps every block on the language you chose last.
 */
/** `name` makes each code region's label unique on a page that holds several blocks. */
export function SampleTabs({
  id,
  samples,
  name,
}: {
  id: string;
  samples: Sample[];
  name?: string;
}) {
  return (
    <div className="code samples" data-samples>
      <div className="code-h" role="radiogroup" aria-label="Language">
        {samples.map((s, i) => (
          <span key={s.lang} className="tab-wrap">
            <input
              type="radio"
              className="sr tab-radio"
              name={`${id}-lang`}
              id={`${id}-${s.lang}`}
              value={s.lang}
              data-lang={s.lang}
              defaultChecked={i === 0}
            />
            <label className="tab" htmlFor={`${id}-${s.lang}`}>
              {s.label}
              {s.soon ? (
                <>
                  <span className="soon-dot" aria-hidden="true" />
                  <span className="sr"> (SDK soon)</span>
                </>
              ) : null}
            </label>
          </span>
        ))}
        <CopyButton label="Copy sample" />
      </div>
      {samples.map((s) => (
        <div key={s.lang} className="panel" data-panel={s.lang}>
          <CodeRegion
            html={highlight(s.code, s.lang)}
            label={`${name ? `${name}: ` : ''}${s.label} sample`}
          />
        </div>
      ))}
      {samples.length > 1 ? (
        // One button per language: copies that sample whichever tab is open.
        <div className="code-f">
          <span className="xs muted">{DEV_COPY.reference.copyAs}</span>
          {samples.map((s) => (
            <button
              key={s.lang}
              type="button"
              className="linkbtn"
              data-copy-as={s.lang}
              aria-label={`${DEV_COPY.reference.copyAs} ${s.label}`}
            >
              {s.label}
            </button>
          ))}
          <button
            type="button"
            className="linkbtn"
            data-copy-as="md"
            aria-label={`${DEV_COPY.reference.copyAs} Markdown`}
          >
            Markdown
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function JsonBlock({ json, label }: { json: unknown; label: string }) {
  const lang: Lang = 'json';
  return (
    <div className="code json">
      <CodeRegion html={highlight(JSON.stringify(json, null, 2), lang)} label={label} />
    </div>
  );
}
