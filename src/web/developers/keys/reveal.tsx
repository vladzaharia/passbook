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
  onHide,
  now = Date.now,
}: {
  revealed: Revealed;
  onDone: () => void;
  /** The secret is no longer on screen: the page replaces its own copy with the mask. */
  onHide?: () => void;
  now?: () => number;
}) {
  const c = KEYS_COPY.reveal;
  // The sheet holds the only copy once it hides; Copy lets go of it for good.
  const [held, setHeld] = useState(revealed.secret);
  const [lost] = useState(revealed.secret === null);
  const [mask] = useState(() => (revealed.secret ? maskSecret(revealed.secret) : ''));
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const hide = useRef(onHide);
  hide.current = onHide;
  useEffect(() => {
    if (held === null || hidden) return;
    const t = setTimeout(() => {
      setHidden(true);
      hide.current?.();
    }, HIDE_MS);
    return () => clearTimeout(t);
  }, [held, hidden]);
  const copy = async () => {
    if (held !== null && (await copyToClipboard(envLine(held)))) setCopied(true);
  };
  // The clipboard holds it now: the page lets go after the "Copied" beat.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => {
      setHidden(true);
      setHeld(null);
      hide.current?.();
    }, 900);
    return () => clearTimeout(t);
  }, [copied]);
  const stops = revealed.stopsAt;
  const shown = held !== null && !hidden;
  return (
    <Sheet
      title={revealed.name}
      onClose={onDone}
      guard={held !== null && !copied}
      onBlocked={() => setBlocked(true)}
      footer={
        <>
          {lost ? null : (
            <button type="button" className="btn" onClick={() => void copy()} disabled={!shown}>
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
      {lost ? (
        <p className="sm ks-note">{c.lost}</p>
      ) : (
        <div className="ks-env" data-hidden={!shown || undefined}>
          <div className="ks-env-h">
            <span className="mono xs muted">{c.env}</span>
            <span className="pill accent ks-once">{c.shownOnce}</span>
          </div>
          <code className="ks-env-v" data-testid="ks-secret">
            PASSBOOK_KEY=<span className="ks-secret">{shown ? held : mask}</span>
          </code>
          <p className="xs muted" aria-live="polite">
            {hidden ? c.masked : ''}
          </p>
          {hidden && held !== null ? (
            <button
              type="button"
              className="btn sm outline ks-again"
              onClick={() => setHidden(false)}
            >
              {c.showAgain}
            </button>
          ) : null}
          <p className="xs muted" role="status">
            {copied ? c.clipboard : blocked && held !== null ? c.copyFirst : ''}
          </p>
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
