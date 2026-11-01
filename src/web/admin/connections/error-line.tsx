import { errorMessage } from './labels.ts';

/** Sentence from the code map; the code follows in mono. */
export function ErrorLine({ code }: { code: string | null | undefined }) {
  const text = errorMessage(code);
  if (!text) return null;
  return (
    <span className="text-xs text-danger">
      {text} <span className="font-mono text-fg-muted">{code}</span>
    </span>
  );
}
