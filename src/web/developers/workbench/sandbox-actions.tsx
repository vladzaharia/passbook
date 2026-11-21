import { Check, Copy, RotateCcw, Unlock } from 'lucide-react';
import { useRef, useState } from 'react';
import type { DeveloperHomeSandbox } from '../../../shared/contracts/developer-home.ts';
import { resetSandboxConfirm } from '../../lib/confirms.ts';
import {
  ActionError,
  reopenSandbox,
  resetSandbox,
  type WithKey,
} from '../console/sandbox-actions.ts';
import { loadSession } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';
import { copyToClipboard } from '../playground/copy.ts';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The new key after a reset or reopen: text only, shown once, and gone when the panel is closed. */
function NewKey({
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

/** Reset: a consequence confirm, the Turnstile check, then the new key. */
export function ResetAction({ onChanged }: { onChanged: () => void }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'working' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<WithKey | null>(null);
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
      setOut(await resetSandbox(session.csrf, token));
      setStep('done');
    } catch (e) {
      setError(e instanceof ActionError ? e.message : 'The check did not pass. Try again.');
      setStep('confirm');
    }
  };
  if (step === 'done' && out)
    return (
      <NewKey
        done
        secret={out.secret}
        line={`Reset. Deleted ${plural(out.deleted?.passes ?? 0, 'pass', 'passes')}, ${plural(out.deleted?.captures ?? 0, 'captured event')} and ${plural(out.deleted?.calls ?? 0, 'call')}. ${out.resetsLeft ?? 0} left today.`}
        onClose={() => {
          setStep('idle');
          setOut(null);
          onChanged();
        }}
      />
    );
  return (
    <>
      {step === 'idle' ? (
        <button type="button" className="btn sm outline" onClick={() => setStep('confirm')}>
          <RotateCcw aria-hidden="true" />
          Reset
        </button>
      ) : (
        <section className="wb-act wb-confirm" aria-label={resetSandboxConfirm.title}>
          <strong>{resetSandboxConfirm.title}</strong>
          <p className="sm">{resetSandboxConfirm.description}</p>
          {error ? (
            <p className="sm qs-bad" role="alert">
              {error}
            </p>
          ) : null}
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
              className="btn sm ghost"
              disabled={step === 'working'}
              onClick={() => setStep('idle')}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
      <div ref={host} className="check" data-shown={showCheck} />
    </>
  );
}

/** Reopen: inside the window, for a sandbox its person or the idle sweep closed. */
export function ReopenAction({
  sandbox,
  onChanged,
}: {
  sandbox: DeveloperHomeSandbox;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<WithKey | null>(null);
  if (sandbox.reopenUntil === null || sandbox.closeReason === 'admin') return null;
  if (out)
    return (
      <NewKey
        done
        secret={out.secret}
        line="Reopened. Your key was replaced."
        onClose={() => {
          setOut(null);
          onChanged();
        }}
      />
    );
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await loadSession();
      if (session.kind === 'out') throw new ActionError('Sign in again.');
      setOut(await reopenSandbox(session.csrf));
    } catch (e) {
      setError(e instanceof ActionError ? e.message : 'That did not work. Try again.');
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
      {error ? (
        <p className="sm qs-bad" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
