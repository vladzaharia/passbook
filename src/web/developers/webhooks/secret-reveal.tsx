import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../shell/copy.ts';

export const REVEAL_MS = 60_000;

/**
 * A signing secret, shown once. It hides after Copy or after 60 s, and the parent drops it from state
 * on `onHide`, so nothing of it stays behind. The secret is never put in an attribute or a DOM copy hook.
 */
export function SecretReveal({
  title = 'Signing secret',
  secret,
  onHide,
}: {
  title?: string;
  secret: string;
  onHide: () => void;
}) {
  const [copied, setCopied] = useState<'idle' | 'failed'>('idle');
  const hide = useRef(onHide);
  hide.current = onHide;
  useEffect(() => {
    const timer = setTimeout(() => hide.current(), REVEAL_MS);
    return () => clearTimeout(timer);
  }, []);

  async function copy() {
    if (await copyToClipboard(secret)) onHide();
    else setCopied('failed');
  }

  return (
    <div className="card card-b stack g2" role="status">
      <div className="row">
        <h2 className="h3">{title}</h2>
        <span className="pill info push">Shown once</span>
      </div>
      <div className="cmd">
        <code>{secret}</code>
      </div>
      {copied === 'failed' ? (
        <p className="wh-msg" role="alert">
          Could not copy. Select the secret and copy it.
        </p>
      ) : null}
      <div className="row g2">
        <button type="button" className="btn sm" onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className="btn ghost sm" onClick={onHide}>
          Hide
        </button>
      </div>
      <span className="xs muted">Hides after Copy or 1 minute.</span>
    </div>
  );
}
