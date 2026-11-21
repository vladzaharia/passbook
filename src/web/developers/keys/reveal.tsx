import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import { envLine } from '../../../shared/developers-keys.ts';
import { copyToClipboard } from '../playground/copy.ts';
import { clock, maskSecret } from './model.ts';
import { Sheet } from './sheet.tsx';

/** A key the server just returned: the only copy there will be. */
export interface Revealed {
  name: string;
  secret: string | null;
  scopes: readonly string[];
  /** Set after a roll: when the old key stops, in ms. */
  stopsAt?: number;
}

/** The secret stays readable until it is copied or this long has passed. */
export const HIDE_MS = 60_000;

/**
 * The one-time sheet after a mint or a roll. The key is a text node in this sheet only: it is hidden after Copy or 60
 * seconds, never stored, and gone from state when the sheet closes. Escape and the backdrop wait for a copy.
 */
export function RevealSheet({
  revealed,
  onDone,
  now = Date.now,
}: {
  revealed: Revealed;
  onDone: () => void;
  now?: () => number;
}) {
  const c = KEYS_COPY.reveal;
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);
  const secret = revealed.secret;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (secret === null) return;
    timer.current = setTimeout(() => setHidden(true), HIDE_MS);
    return () => clearTimeout(timer.current);
  }, [secret]);
  const copy = async () => {
    if (secret !== null && (await copyToClipboard(envLine(secret)))) setCopied(true);
  };
  // The clipboard holds it now: the page lets go after the "Copied" beat.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setHidden(true), 900);
    return () => clearTimeout(t);
  }, [copied]);
  const stops = revealed.stopsAt;
  return (
    <Sheet
      title={revealed.name}
      onClose={onDone}
      guard={secret !== null && !copied && !hidden}
      footer={
        <>
          {secret === null ? null : (
            <button type="button" className="btn" onClick={() => void copy()} disabled={hidden}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? c.copied : c.copy}
            </button>
          )}
          <button type="button" className="btn outline" onClick={onDone}>
            {c.done}
          </button>
        </>
      }
    >
      {secret === null ? (
        <p className="sm ks-note">{c.lost}</p>
      ) : (
        <div className="ks-env" data-hidden={hidden || undefined}>
          <div className="ks-env-h">
            <span className="mono xs muted">{c.env}</span>
            <span className="pill accent ks-once">{c.shownOnce}</span>
          </div>
          <code className="ks-env-v" data-testid="ks-secret">
            PASSBOOK_KEY=<span className="ks-secret">{hidden ? maskSecret(secret) : secret}</span>
          </code>
          {hidden ? <p className="xs muted">{c.masked}</p> : null}
        </div>
      )}
      <div className="wrap-row g2 ks-chips">
        {revealed.scopes.map((s) => (
          <code key={s} className="chip mono">
            {s}
          </code>
        ))}
      </div>
      {stops === undefined ? null : (
        <p className="sm muted">{stops <= now() ? c.stoppedNow : c.stops(clock(stops))}</p>
      )}
    </Sheet>
  );
}
