import { RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PATHS } from '../../../shared/developers.ts';
import {
  deleteSandboxConfirm,
  sandboxWorking,
  startOverSandboxConfirm,
} from '../../lib/confirms-developer.ts';
import { ActionError, deleteSandbox, recreateSandbox } from '../console/sandbox-actions.ts';
import type { Sandbox } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';
import { WorkingNote } from '../ui/working-note.tsx';

type Act = 'start-over' | 'delete';
const COPY = { 'start-over': startOverSandboxConfirm, delete: deleteSandboxConfirm } as const;
const HASH: Record<string, Act> = { '#start-over': 'start-over', '#delete-sandbox': 'delete' };
/** The confirm that was open when Polaris ID took the person away for a fresh sign-in. */
const RESUME = 'qs-manage-resume';

const resumed = (): Act | null => {
  try {
    const v = sessionStorage.getItem(RESUME);
    sessionStorage.removeItem(RESUME);
    return v === 'delete' || v === 'start-over' ? v : null;
  } catch {
    return null;
  }
};

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
  // Bumped on every request to open, so the confirm scrolls into view even when it is already open.
  const [opened, setOpened] = useState(0);
  const busy = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const open = useCallback((a: Act) => {
    if (busy.current) return;
    setAct(a);
    setError(null);
    setOpened((n) => n + 1);
  }, []);
  // The chip menu links here with a hash: on arrival, and while already here (a hash change loads nothing).
  // The hash is dropped once read, so choosing the same item again changes it again.
  useEffect(() => {
    const fromHash = () => {
      const a = HASH[window.location.hash];
      if (!a) return;
      open(a);
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {
        // No history to edit: the hash stays and the next choice has none to change.
      }
    };
    const back = resumed();
    if (back) open(back);
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [open]);
  // The confirm sits below the steps: bring it into view and give it focus, so the screen reader says it.
  useEffect(() => {
    if (!opened || !panel.current) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panel.current.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    panel.current.focus({ preventScroll: true });
  }, [opened]);

  const run = async () => {
    if (!act) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    try {
      if (act === 'delete') {
        await deleteSandbox(csrf);
        // A fresh load reads the session again: the page is the signed-in, no-sandbox quickstart. The working
        // state stays until it leaves, so the confirm never comes back over a sandbox that is gone.
        window.location.assign(PATHS.quickstart);
        return;
      }
      if (!siteKey || !host.current) throw new ActionError('Reload and try again.');
      host.current.replaceChildren();
      const token = await verify(host.current, siteKey, setShowCheck).catch(() => {
        throw new ActionError('The check did not pass. Try again.');
      });
      const made = await recreateSandbox(csrf, token);
      setAct(null);
      busy.current = false;
      setWorking(false);
      history.replaceState(null, '', PATHS.quickstart);
      onMade(made.sandbox, made.secret);
    } catch (e) {
      setError(
        e instanceof ActionError
          ? { text: e.message, signInUrl: e.signInUrl }
          : { text: "Couldn't reach PassBook. Try again.", signInUrl: undefined },
      );
      busy.current = false;
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
          onClick={() => open('start-over')}
        >
          <RotateCcw aria-hidden="true" />
          Start over
        </button>
        <button
          type="button"
          className="btn sm outline"
          disabled={working}
          onClick={() => open('delete')}
        >
          <Trash2 aria-hidden="true" />
          Delete sandbox
        </button>
      </div>
      {copy && act ? (
        <section
          ref={panel}
          tabIndex={-1}
          className="qs-confirm"
          aria-label={copy.title}
          aria-busy={working}
        >
          {working ? (
            <WorkingNote {...sandboxWorking[act]} />
          ) : (
            <>
              <strong>{copy.title}</strong>
              <p className="sm">{copy.description}</p>
              {error ? (
                <p className="sm qs-bad" role="alert">
                  {error.text}{' '}
                  {error.signInUrl ? (
                    <a
                      href={error.signInUrl}
                      onClick={() => {
                        try {
                          sessionStorage.setItem(RESUME, act);
                        } catch {
                          // The confirm just will not reopen after the sign-in.
                        }
                      }}
                    >
                      Continue to Polaris ID
                    </a>
                  ) : null}
                </p>
              ) : null}
              <div className="row g2 wrap-row">
                <button type="button" className="btn sm danger" onClick={() => void run()}>
                  {copy.confirmLabel}
                </button>
                <button
                  type="button"
                  className="btn sm outline"
                  onClick={() => {
                    setAct(null);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}
      <div ref={host} className="check" data-shown={showCheck} />
    </div>
  );
}
