import { useEffect, useState } from 'react';
import { QS_COPY } from '@/shared/copy/developers-quickstart.ts';
import { CopyButton } from '../../ui/copy-button.tsx';
import { maskKey } from '../quickstart/model.ts';

const M = QS_COPY.made;
/** The key stays readable this long, then masks, like the quickstart's. */
const REVEAL_MS = 60_000;

/**
 * The new key after a reset, shown once: the secret is a text node of this block only, never an
 * attribute, storage or the address, and it masks after a minute.
 */
export function KeyReveal({ secret }: { secret: string }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShown(false), REVEAL_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
      <code className="min-w-0 flex-1 break-all font-mono text-[0.8125rem] text-fg-strong">
        {shown ? secret : maskKey(secret)}
      </code>
      {shown ? <span className="text-xs text-warning">{M.once}</span> : null}
      <CopyButton value={secret} label="Copy key" />
    </div>
  );
}
