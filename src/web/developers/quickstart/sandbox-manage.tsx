import { RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PATHS } from '../../../shared/developers.ts';
import { deleteSandboxConfirm, startOverSandboxConfirm } from '../../lib/confirms-developer.ts';
import { ActionError, deleteSandbox, recreateSandbox } from '../console/sandbox-actions.ts';
import type { Sandbox } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';

type Act = 'start-over' | 'delete';
const COPY = { 'start-over': startOverSandboxConfirm, delete: deleteSandboxConfirm } as const;
const HASH: Record<string, Act> = { '#start-over': 'start-over', '#delete-sandbox': 'delete' };

/**
 * Start over and Delete sandbox, each behind a consequence confirm. Start over makes a new sandbox and hands its key
 * to the page (shown once, in the key step); Delete returns to the quickstart's first step. The chip menu links here
 * with `#start-over` or `#delete-sandbox`, which opens the confirm.
 */
export function SandboxManage({
  csrf,
  siteKey,
  onMade,
}: {
  csrf: string;
  siteKey: string;
  onMade: (sandbox: Sandbox, secret: string | null) => void;
}) {
  const [act, setAct] = useState<Act | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<{ text: string; signInUrl: string | undefined } | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fromHash = HASH[window.location.hash];
    if (fromHash) setAct(fromHash);
  }, []);

  const run = async () => {
    if (!act) return;
    setWorking(true);
    setError(null);
    try {
      if (act === 'delete') {
        await deleteSandbox(csrf);
        // A fresh read of the session: the page is the signed-in, no-sandbox quickstart again.
        window.location.assign(PATHS.quickstart);
        return;
      }
      if (!siteKey || !host.current) throw new ActionError('Reload and try again.');
      host.current.replaceChildren();
      const token = await verify(host.current, siteKey, setShowCheck);
      const made = await recreateSandbox(csrf, token);
      setAct(null);
      history.replaceState(null, '', PATHS.quickstart);
      onMade(made.sandbox, made.secret);
    } catch (e) {
      setError(
        e instanceof ActionError
          ? { text: e.message, signInUrl: e.signInUrl }
          : { text: 'The check did not pass. Try again.', signInUrl: undefined },
      );
    } finally {
      setWorking(false);
    }
  };

  const copy = act ? COPY[act] : null;
  return (
    <div className="qs-manage">
      <div className="row g2 wrap-row">
        <button
          type="button"
          className="btn sm outline"
          disabled={working}
          onClick={() => setAct('start-over')}
        >
          <RotateCcw aria-hidden="true" />
          Start over
        </button>
        <button
          type="button"
          className="btn sm outline"
          disabled={working}
          onClick={() => setAct('delete')}
        >
          <Trash2 aria-hidden="true" />
          Delete sandbox
        </button>
      </div>
      {copy ? (
        <section className="qs-confirm" aria-label={copy.title}>
          <strong>{copy.title}</strong>
          <p className="sm">{copy.description}</p>
          {error ? (
            <p className="sm qs-bad" role="alert">
              {error.text}{' '}
              {error.signInUrl ? <a href={error.signInUrl}>Continue to Polaris ID</a> : null}
            </p>
          ) : null}
          <div className="row g2 wrap-row">
            <button
              type="button"
              className="btn sm"
              disabled={working}
              aria-busy={working}
              onClick={() => void run()}
            >
              {working ? 'Working' : copy.confirmLabel}
            </button>
            <button
              type="button"
              className="btn sm outline"
              disabled={working}
              onClick={() => {
                setAct(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      <div ref={host} className="check" data-shown={showCheck} />
    </div>
  );
}
