import { RotateCcw, Unlock } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeveloperHomeSandbox } from '../../../shared/contracts/developer-home.ts';
import { resetSandboxConfirm } from '../../lib/confirms-developer.ts';
import { ActionError, reopenSandbox, resetSandbox } from '../console/sandbox-actions.ts';
import { loadSession } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';

/** The step-up answer: the sentence and the link to Polaris ID, as the Keys page shows it. */
function Problem({ text, signInUrl }: { text: string; signInUrl: string | undefined }) {
  return (
    <p className="sm qs-bad" role="alert">
      {text} {signInUrl ? <a href={signInUrl}>Continue to Polaris ID</a> : null}
    </p>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a reset or reopen hands back: its sentence and the new key, shown once in the head. */
export interface Reveal {
  line: string;
  secret: string | null;
}

/**
 * Reset: a consequence confirm below the head's buttons (`panel` is the slot it goes in), the Turnstile check, then
 * the new key, which the head shows (`onKey`) so it outlives the refresh the reset causes.
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
  const [step, setStep] = useState<'idle' | 'confirm' | 'working'>('idle');
  const [error, setError] = useState<{ text: string; signInUrl: string | undefined } | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const run = async () => {
    setStep('working');
    setError(null);
    try {
      const session = await loadSession();
      if (session.kind !== 'ready' || !host.current) throw new ActionError('Reload and try again.');
      host.current.replaceChildren();
      const token = await verify(host.current, session.siteKey, setShowCheck);
      const done = await resetSandbox(session.csrf, token);
      if (done.more) {
        // The purge ran out of time: no key yet. Asking again resumes it and spends no reset.
        setError({
          text: `Part of the data is left (${plural(done.deleted?.passes ?? 0, 'pass', 'passes')} deleted so far). Reset again to finish. It costs no reset.`,
          signInUrl: undefined,
        });
        setStep('confirm');
        return;
      }
      setStep('idle');
      onKey({
        secret: done.secret,
        line: `Reset. Deleted ${plural(done.deleted?.passes ?? 0, 'pass', 'passes')}, ${plural(done.deleted?.captures ?? 0, 'captured event')} and ${plural(done.deleted?.calls ?? 0, 'call')}.${done.kept ? ` ${plural(done.kept, 'pass', 'passes')} could not be deleted yet.` : ''} ${done.resetsLeft ?? 0} left today.`,
      });
      // The old calls, counts and keys are gone: the workbench reads the new home now.
      onChanged();
    } catch (e) {
      setError(
        e instanceof ActionError
          ? { text: e.message, signInUrl: e.signInUrl }
          : { text: 'The check did not pass. Try again.', signInUrl: undefined },
      );
      setStep('confirm');
    }
  };
  const confirm: ReactNode =
    step === 'idle' ? null : (
      <section className="wb-act wb-confirm" aria-label={resetSandboxConfirm.title}>
        <strong>{resetSandboxConfirm.title}</strong>
        <p className="sm">{resetSandboxConfirm.description}</p>
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
