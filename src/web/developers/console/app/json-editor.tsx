import { highlightTokens } from '../../model/highlight.ts';

/**
 * The body as JSON text with a line gutter and colour. A textarea over a highlighted copy of its
 * own text: the copy is drawn as elements, the textarea only holds the text and the caret.
 */
export function JsonEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  const lines = highlightTokens(value, 'json');
  return (
    <div className="editor">
      <div className="gutter mono" aria-hidden="true">
        {lines.map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are positional
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <div className="ed-stack">
        <pre className="src hl" aria-hidden="true">
          <code>
            {lines.map((toks, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
              <span key={i} className="ln">
                {toks.map((t, j) =>
                  t.cls ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                    <span key={j} className={t.cls}>
                      {t.text}
                    </span>
                  ) : (
                    t.text
                  ),
                )}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
        <textarea
          value={value}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label="Request body (JSON)"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
