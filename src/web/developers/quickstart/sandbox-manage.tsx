import { RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PATHS } from '../../../shared/developers.ts';
import {
  deleteSandboxConfirm,
  sandboxWorking,
  startOverSandboxConfirm,
} from '../../lib/confirms-developer.ts';
import { useOperation } from '../../ui/operation/index.ts';
import {
  ActionError,
  mintKey,
  sandboxOfOperation,
  startDelete,
  startRecreate,
} from '../console/sandbox-actions.ts';
import type { Sandbox } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';
import { SandboxOperation, startedOperation } from '../ui/sandbox-operation.tsx';
import { WorkingNote } from '../ui/working-note.tsx';

type Act = 'start-over' | 'delete';
const COPY = { 'start-over': startOverSandboxConfirm, delete: deleteSandboxConfirm } as const;
const HASH: Record<string, Act> = { '#start-over': 'start-over', '#delete-sandbox': 'delete' };
const KIND: Record<string, Act> = { 'sandbox.delete': 'delete', 'sandbox.recreate': 'start-over' };
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
 * Start over and Delete sandbox, each behind a consequence confirm. Once confirmed, the confirm shows the operation
 * live (every step with its count, Retry on the one that failed; `op` is the one `?op=` names, so a reload brings it
 * back). Start over makes a new sandbox and hands its key to the page (minted once, shown in the key step); Delete ends
 * on "Create sandbox", which returns to the quickstart's first step. The chip menu links here with `#start-over` or
 * `#delete-sandbox`, which opens the confirm.
 */
export function SandboxManage({
  csrf,
  siteKey,
  onMade,
  op,
  onOp,
  buttons = true,
}: {
  csrf: string;
  siteKey: string;
  onMade: (sandbox: Sandbox, secret: string | null) => void;
  op: string | null;
  onOp: (id: string | null) => void;
  /** False once the sandbox is gone: only the operation that removed it is left to show. */
  buttons?: boolean;
}) {
  const [picked, setAct] = useState<Act | null>(null);
  // Only a reload needs the kind to be asked for: a confirm that started it knows its own.
  const { operation } = useOperation(picked ? null : op);
  const act = picked ?? (operation ? (KIND[operation.kind] ?? null) : null);
  const opRef = useRef(op);
  opRef.current = op;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<{ text: string; signInUrl: string | undefined } | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  // Bumped on every request to open, so the confirm scrolls into view even when it is already open.
  const [opened, setOpened] = useState(0);
  const busy = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const open = useCallback((a: Act) => {
    if (busy.current || opRef.current) return;
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
        const started = await startDelete(csrf);
        startedOperation(started);
        onOp(started.id);
      } else {
        if (!siteKey || !host.current) throw new ActionError('Reload and try again.');
        host.current.replaceChildren();
        const token = await verify(host.current, siteKey, setShowCheck).catch(() => {
          throw new ActionError('The check did not pass. Try again.');
        });
        const started = await startRecreate(csrf, token);
        startedOperation(started);
        onOp(started.id);
      }
    } catch (e) {
      // One is already running (another tab, a reload): follow it instead of showing an error.
      if (e instanceof ActionError && e.operationId) onOp(e.operationId);
      else
        setError(
          e instanceof ActionError
            ? { text: e.message, signInUrl: e.signInUrl }
            : { text: "Couldn't reach PassBook. Try again.", signInUrl: undefined },
        );
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  /** Start over ended well: the new sandbox's key is minted once, here, and handed to the key step. */
  const finish = useCallback(
    (done: Parameters<typeof sandboxOfOperation>[0]) => {
      if (done.kind !== 'sandbox.recreate') return;
      const made = sandboxOfOperation(done);
      if (!made) return;
      void mintKey(csrf)
        .catch(() => null)
        .then((secret) => {
          history.replaceState(null, '', PATHS.quickstart);
          setAct(null);
          onOp(null);
          onMade(made, secret);
        });
    },
    [csrf, onMade, onOp],
  );
  const leave = () => {
    if (act === 'delete') window.location.assign(PATHS.quickstart);
    else {
      setAct(null);
      onOp(null);
    }
  };

  const copy = act ? COPY[act] : null;
  return (
    <div className="qs-manage">
      {buttons ? (
        <div className="row g2 wrap-row">
          <button
            type="button"
            className="btn sm outline"
            disabled={working || op !== null}
            onClick={() => open('start-over')}
          >
            <RotateCcw aria-hidden="true" />
            Start over
          </button>
          <button
            type="button"
            className="btn sm outline"
            disabled={working || op !== null}
            onClick={() => open('delete')}
          >
            <Trash2 aria-hidden="true" />
            Delete sandbox
          </button>
        </div>
      ) : null}
      {copy && act ? (
        <section
          ref={panel}
          tabIndex={-1}
          className="qs-confirm"
          aria-label={copy.title}
          aria-busy={working || op !== null}
        >
          {op ? (
            <SandboxOperation
              id={op}
              next={
                act === 'delete'
                  ? {
                      label: 'Create sandbox',
                      onClick: () => window.location.assign(PATHS.quickstart),
                    }
                  : undefined
              }
              onSucceeded={finish}
              onGone={() => onOp(null)}
              onClose={leave}
            />
          ) : working ? (
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
