import { useEffect, useState } from 'react';
import type { InputValues } from './model.ts';

/** The input as JSON. Text you are typing stays yours; a valid object becomes the input at once. */
export function JsonEditor({
  values,
  onValues,
}: {
  values: InputValues;
  onValues: (values: InputValues) => void;
}) {
  const canonical = JSON.stringify(values, null, 2);
  const [text, setText] = useState(canonical);
  const [bad, setBad] = useState<string | null>(null);
  // An outside change (Reset, a new template, Back) replaces the text unless it is what was just typed.
  useEffect(() => {
    setText((now) => {
      try {
        return JSON.stringify(JSON.parse(now)) === JSON.stringify(values) ? now : canonical;
      } catch {
        return canonical;
      }
    });
    setBad(null);
  }, [values, canonical]);
  return (
    <div className="field">
      <label htmlFor="pg-json">Input</label>
      <textarea
        id="pg-json"
        className="input json"
        value={text}
        spellCheck={false}
        rows={16}
        aria-invalid={bad ? true : undefined}
        aria-describedby={bad ? 'pg-json-err' : undefined}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed: unknown = JSON.parse(e.target.value);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
              return setBad('The input is an object.');
            setBad(null);
            onValues(parsed as InputValues);
          } catch {
            setBad('Not valid JSON yet.');
          }
        }}
      />
      {bad ? (
        <span className="help bad-t" id="pg-json-err" role="alert">
          {bad}
        </span>
      ) : null}
    </div>
  );
}
