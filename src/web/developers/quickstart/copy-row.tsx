import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { copyToClipboard } from '../playground/copy.ts';

/** A labelled line with one Copy button that says "Copied" in place. The value is what lands on the clipboard; the text is what is drawn. */
export function CopyRow({
  label,
  text,
  value,
  onCopied,
}: {
  label: string;
  text: string;
  value: string;
  onCopied?: () => void;
}) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    if (!(await copyToClipboard(value))) return;
    setDone(true);
    onCopied?.();
    setTimeout(() => setDone(false), 1800);
  };
  const c = QS_COPY.steps.home;
  return (
    <div className="qs-copy">
      <span className="mono xs muted qs-copy-l">{label}</span>
      <code className="mono qs-copy-v">{text}</code>
      <button
        type="button"
        className={done ? 'btn sm outline qs-copied' : 'btn sm outline'}
        aria-label={`${c.copy} ${label}`}
        onClick={() => void copy()}
      >
        {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {done ? c.copied : c.copy}
      </button>
    </div>
  );
}
