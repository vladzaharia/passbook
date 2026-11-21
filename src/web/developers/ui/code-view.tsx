import { ENV_CHIP, highlightTokens, type Lang } from '../model/highlight.ts';

/** Text with the key placeholder drawn as the chip. Text nodes only: no markup is ever parsed. */
function Chipped({ text }: { text: string }) {
  const parts = text.split(ENV_CHIP);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
          <span key={i} className="envchip">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** Highlighted code as elements: the same token classes as the prerendered pages, without innerHTML. */
export function CodeView({ code, lang, label }: { code: string; lang: Lang; label: string }) {
  const lines = highlightTokens(code, lang);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code region
    <section className="region" tabIndex={0} aria-label={label}>
      <pre className="src">
        <code>
          {lines.map((toks, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            <span key={i} className="ln">
              {toks.map((t, j) =>
                t.cls ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                  <span key={j} className={t.cls}>
                    <Chipped text={t.text} />
                  </span>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                  <Chipped key={j} text={t.text} />
                ),
              )}
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
}
