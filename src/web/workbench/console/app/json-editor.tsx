import { highlightTokens } from '../../../developers/model/highlight.ts';

/**
 * The body as JSON text with colour and line numbers. A textarea over a highlighted copy of its own
 * text: the copy is drawn as elements, the textarea only holds the text and the caret. Both wrap at
 * the same width, and each line of the copy carries its own number, so a wrapped line keeps one.
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
            </span>
          ))}
        </code>
      </pre>
      <textarea
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label="Request body (JSON)"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
