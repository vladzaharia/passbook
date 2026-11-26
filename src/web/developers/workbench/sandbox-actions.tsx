import { RotateCcw, Unlock } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeveloperHomeSandbox } from '../../../shared/contracts/developer-home.ts';
import { SANDBOX_KEY_SHOWN_COPY } from '../../../shared/copy/developer.ts';
import { resetSandboxConfirm } from '../../lib/confirms-developer.ts';
import {
  type Operation,
  useClaimOperation,
  useOperation,
  useOperationParam,
} from '../../ui/operation/index.ts';
import { useCachedOperation } from '../../ui/operation/store.ts';
import { ActionError, mintKey, reopenSandbox, startReset } from '../console/sandbox-actions.ts';
import { loadSession } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';
import {
  doneNoteOf,
  SandboxOperation,
  SandboxOperations,
  startedOperation,
} from '../ui/sandbox-operation.tsx';

/** The step-up answer: the sentence and the link to Polaris ID, as the Keys page shows it. */
function Problem({ text, signInUrl }: { text: string; signInUrl: string | undefined }) {
  return (
    <p className="sm qs-bad" role="alert">
      {text} {signInUrl ? <a href={signInUrl}>Continue to Polaris ID</a> : null}
    </p>
  );
}

/** What a reset or reopen hands back: its sentence and the new key, shown once in the head. */
export interface Reveal {
  line: string;
  secret: string | null;
  /** The key was minted before (a reload after it was shown): no sheet, only the line. */
  shown?: boolean;
}

/** The reset's panel: it claims `?op` while it shows, and gives the id back when the id names some other kind. */
function ResetRun({
  id,
  onSucceeded,
  onLeave,
  onOther,
}: {
  id: string;
  onSucceeded: (done: Operation) => void;
  onLeave: () => void;
  /** The id names another kind: this panel steps aside and leaves `?op` to its owner. */
  onOther: () => void;
}) {
  const { operation } = useOperation(id);
  const ours = !operation || operation.kind === 'sandbox.reset';
  useEffect(() => {
    if (!ours) onOther();
  }, [ours, onOther]);
  if (!ours) return null;
  return <SandboxOperation id={id} onSucceeded={onSucceeded} onGone={onLeave} onClose={onLeave} />;
}

/**
 * Reset: a consequence confirm below the head's buttons (`panel` is the slot it goes in), the Turnstile check, then
 * the operation live in the confirm, which `?op` keeps across a reload. When it ends well the new key is minted once
 * and the head shows it (`onKey`), so it outlives the refresh the reset causes. A key shown before is not minted again.
 */
export function ResetAction({
  onChanged,
  onKey,
  panel,
}: {
  onChanged: () => void;
  onKey: (reveal: Reveal) => void;
  panel: HTMLElement | null;
}) {
  const [opId, setOpId] = useOperationParam();
  // Claimed from the first paint, before the session reads: the tray opens no second sheet for this id.
  const seen = useCachedOperation(opId);
  // The id stays claimed after the panel is done with it: the tray's own sheet reads the same address and would open.
  const [spent, setSpent] = useState<string | null>(null);
  const claimed = opId ?? spent;
  useClaimOperation(claimed && (!seen || seen.kind === 'sandbox.reset') ? claimed : null);
  const [step, setStep] = useState<'idle' | 'confirm' | 'working'>(opId ? 'working' : 'idle');
  const [error, setError] = useState<{ text: string; signInUrl: string | undefined } | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  /** The reset under way, and the write token its panel's retry and its key use. */
  const [op, setOp] = useState<{ id: string; csrf: string } | null>(null);
  /** The reset ended and the key is not minted yet: Try again asks for it. */
  const [ended, setEnded] = useState<Operation | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const release = () => {
    setOp(null);
    setEnded(null);
    setStep('idle');
  };
  const leave = () => {
    setSpent(op?.id ?? opId);
    setOp(null);
    setEnded(null);
    setOpId(null);
    setStep('idle');
  };
  // A reload with `?op=` names a run: pick it up again, with a fresh write token.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount.
  useEffect(() => {
    if (!opId) return;
    void loadSession().then((session) => {
      if (session.kind === 'ready') setOp({ id: opId, csrf: session.csrf });
      else leave();
    });
  }, []);
  const follow = async (id: string) => {
    const session = await loadSession();
    if (session.kind !== 'ready') return false;
    setOpId(id);
    setOp({ id, csrf: session.csrf });
    return true;
  };
  const run = async () => {
    setStep('working');
    setError(null);
    try {
      const session = await loadSession();
      if (session.kind !== 'ready' || !host.current) throw new ActionError('Reload and try again.');
      host.current.replaceChildren();
      const token = await verify(host.current, session.siteKey, setShowCheck);
      const started = await startReset(session.csrf, token);
      startedOperation(started);
      await follow(started.id);
    } catch (e) {
      // One is already running (another tab, a reload): follow it instead of showing an error.
      if (e instanceof ActionError && e.operationId && (await follow(e.operationId))) return;
      setError(
        e instanceof ActionError
          ? { text: e.message, signInUrl: e.signInUrl }
          : { text: 'The check did not pass. Try again.', signInUrl: undefined },
      );
      setStep('confirm');
    }
  };
  /** The reset ended well: the new key is minted once, here, and the head shows it with what was deleted. */
  const finish = async (done: Operation) => {
    const csrf = op?.csrf;
    if (!csrf) return;
    setEnded(done);
    setError(null);
    let secret: string | null;
    try {
      secret = await mintKey(csrf);
    } catch (e) {
      setError({
        text: e instanceof ActionError ? e.message : 'The new key did not arrive. Try again.',
        signInUrl: e instanceof ActionError ? e.signInUrl : undefined,
      });
      return;
    }
    const line = `Reset. ${doneNoteOf(done) ?? ''}`.trim();
    leave();
    onKey(
      secret === null
        ? { secret, line: `${line} ${SANDBOX_KEY_SHOWN_COPY}`, shown: true }
        : { secret, line },
    );
    // The old calls, counts and keys are gone: the workbench reads the new home now.
    onChanged();
  };
  const confirm: ReactNode =
    step === 'idle' ? null : (
      <section className="wb-act wb-confirm" aria-label={resetSandboxConfirm.title}>
        {op ? null : (
          <>
            <strong>{resetSandboxConfirm.title}</strong>
            <p className="sm">{resetSandboxConfirm.description}</p>
          </>
        )}
        {op ? (
          <SandboxOperations csrf={op.csrf}>
            <ResetRun
              id={op.id}
              onSucceeded={(d) => void finish(d)}
              onLeave={leave}
              onOther={release}
            />
            {ended && error ? (
              <>
                <Problem text={error.text} signInUrl={error.signInUrl} />
                <button type="button" className="btn sm" onClick={() => void finish(ended)}>
                  Try again
                </button>
              </>
            ) : null}
          </SandboxOperations>
        ) : (
          <>
            {error ? <Problem text={error.text} signInUrl={error.signInUrl} /> : null}
            <div className="wrap-row g2">
              <button
                type="button"
                className="btn sm"
                disabled={step === 'working'}
                aria-busy={step === 'working'}
                onClick={() => void run()}
              >
                {step === 'working' ? 'Resetting' : resetSandboxConfirm.confirmLabel}
              </button>
              <button
                type="button"
                className="btn sm outline"
                disabled={step === 'working'}
                onClick={() => setStep('idle')}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </section>
    );
  return (
    <>
      <button
        type="button"
        className="btn sm outline"
        aria-expanded={step !== 'idle'}
        disabled={step !== 'idle'}
        onClick={() => setStep('confirm')}
      >
        <RotateCcw aria-hidden="true" />
        Reset
      </button>
      {panel ? createPortal(confirm, panel) : confirm}
      <div ref={host} className="check" data-shown={showCheck} />
    </>
  );
}

/** Reopen: inside the window, for a sandbox its person or the idle sweep closed. */
export function ReopenAction({
  sandbox,
  onChanged,
  onKey,
}: {
  sandbox: DeveloperHomeSandbox;
  onChanged: () => void;
  onKey: (reveal: Reveal) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; signInUrl: string | undefined } | null>(null);
  if (sandbox.reopenUntil === null || sandbox.closeReason === 'admin') return null;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await loadSession();
      if (session.kind === 'out') throw new ActionError('Sign in again.');
      const done = await reopenSandbox(session.csrf);
      onKey({ secret: done.secret, line: 'Reopened. Your key was replaced.' });
      onChanged();
    } catch (e) {
      setError(
        e instanceof ActionError
          ? { text: e.message, signInUrl: e.signInUrl }
          : { text: 'That did not work. Try again.', signInUrl: undefined },
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="btn sm"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void go()}
      >
        <Unlock aria-hidden="true" />
        Reopen
      </button>
      {error ? <Problem text={error.text} signInUrl={error.signInUrl} /> : null}
    </>
  );
}
