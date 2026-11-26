import { ChevronDown, WrapText } from 'lucide-react';
import { CODE_COPY } from '../../../shared/copy/developers-code.ts';
import { highlight, type Lang } from '../model/highlight.ts';
import type { Sample } from '../model/samples.ts';
import { CopyIcons } from './copy-icons.tsx';
import { SdkBadge } from './sdk-badge.tsx';

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
      <CopyIcons />
    </button>
  );
}

/** Wrap for phones (CSS shows it there); the page's click handler flips it. */
function Wrap() {
  return (
    <button type="button" className="wrapbtn" data-wrap-toggle aria-pressed="false">
      <WrapText className="lucide" aria-hidden="true" />
      {CODE_COPY.wrap}
    </button>
  );
}

/** One Copy as menu: a button per sample plus Markdown. The page's click handler opens it and copies. */
function CopyAs({ id, samples }: { id: string; samples: Sample[] }) {
  return (
    <div className="menu">
      <button
        type="button"
        className="btn ghost sm"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-controls={`${id}-menu`}
        data-menu-toggle
      >
        {CODE_COPY.copyAs}
        <ChevronDown aria-hidden="true" />
      </button>
      <div className="menu-list" role="menu" id={`${id}-menu`} hidden>
        {samples.map((s) => (
          <button
            key={s.lang}
            type="button"
            role="menuitem"
            className="menu-item"
            data-copy-as={s.lang}
          >
            {s.label}
          </button>
        ))}
        <button type="button" role="menuitem" className="menu-item" data-copy-as="md">
          {CODE_COPY.markdown}
        </button>
      </div>
    </div>
  );
}

/**
 * Language tabs without script: radios and labels, the panel shown by :has(:checked). The island
 * keeps every block on the language you chose last. The radios sit in their own group; Copy is outside it.
 * `name` makes each code region's label unique on a page that holds several blocks.
 */
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
      <div className="code-h">
        <div className="tabs" role="radiogroup" aria-label={CODE_COPY.language}>
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
              </label>
            </span>
          ))}
        </div>
        <div className="code-tools">
          {samples.map((s) => (
            <span key={s.lang} className="code-meta only" data-only={s.lang}>
              <span className="file">{s.file}</span>
              {s.soon ? <SdkBadge lang={s.lang} /> : null}
            </span>
          ))}
          <Wrap />
          <CopyButton label="Copy sample" />
          {samples.length > 1 ? <CopyAs id={id} samples={samples} /> : null}
        </div>
      </div>
      {samples.map((s) => (
        <div key={s.lang} className="panel" data-panel={s.lang}>
          <CodeRegion
            html={highlight(s.code, s.lang)}
            label={`${name ? `${name}: ` : ''}${s.label} sample`}
          />
        </div>
      ))}
    </div>
  );
}

/** A response: the same header with the label JSON and Copy. */
export function JsonBlock({ json, label }: { json: unknown; label: string }) {
  const lang: Lang = 'json';
  return (
    <div className="code json">
      <div className="code-h">
        <span className="code-label">{CODE_COPY.json}</span>
        <div className="code-tools">
          <Wrap />
          <CopyButton label="Copy response" />
        </div>
      </div>
      <CodeRegion html={highlight(JSON.stringify(json, null, 2), lang)} label={label} />
    </div>
  );
}
