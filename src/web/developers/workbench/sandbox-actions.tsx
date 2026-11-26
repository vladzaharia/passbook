import { Check, Copy, RotateCcw, Unlock } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeveloperHomeSandbox } from '../../../shared/contracts/developer-home.ts';
import { resetSandboxConfirm } from '../../lib/confirms-developer.ts';
import type { Operation } from '../../ui/operation/index.ts';
import { ActionError, mintKey, reopenSandbox, startReset } from '../console/sandbox-actions.ts';
import { loadSession } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';
import { copyToClipboard } from '../playground/copy.ts';
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

/** The new key after a reset or reopen: text only, shown once, and gone when the panel is closed. */
export function NewKey({
  done,
  secret,
  line,
  onClose,
}: {
  done: boolean;
  secret: string | null;
  line: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (secret && (await copyToClipboard(`PASSBOOK_KEY=${secret}\n`))) setCopied(true);
  };
  return (
    <div className="wb-act wb-newkey" role="status">
      <p className="sm">{line}</p>
      {secret ? (
        <div className="wb-key-box">
          <code className="mono xs">PASSBOOK_KEY={secret}</code>
          <button type="button" className="btn sm outline" onClick={() => void copy()}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : null}
      <p className="xs muted">{done ? 'Shown once.' : ''}</p>
      <button type="button" className="btn sm" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

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
  /** The reset under way, and the write token its panel's retry uses. */
  const [op, setOp] = useState<{ id: string; csrf: string } | null>(null);
  const host = useRef<HTMLDivElement>(null);
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
      setOp({ id: started.id, csrf: session.csrf });
    } catch (e) {
      // One is already running (another tab, a reload): follow it instead of showing an error.
      if (e instanceof ActionError && e.operationId) {
        const session = await loadSession();
        if (session.kind === 'ready') {
          setOp({ id: e.operationId, csrf: session.csrf });
          return;
        }
      }
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
    const secret = await mintKey(csrf).catch(() => null);
    setOp(null);
    setStep('idle');
    onKey({ secret, line: `Reset. ${doneNoteOf(done) ?? ''}`.trim() });
    // The old calls, counts and keys are gone: the workbench reads the new home now.
    onChanged();
  };
  const leave = () => {
    setOp(null);
    setStep('idle');
  };
  const confirm: ReactNode =
    step === 'idle' ? null : (
      <section className="wb-act wb-confirm" aria-label={resetSandboxConfirm.title}>
        <strong>{resetSandboxConfirm.title}</strong>
        {op ? null : <p className="sm">{resetSandboxConfirm.description}</p>}
        {op ? (
          <SandboxOperations csrf={op.csrf}>
            <SandboxOperation
              id={op.id}
              onSucceeded={(d) => void finish(d)}
              onGone={leave}
              onClose={leave}
            />
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
