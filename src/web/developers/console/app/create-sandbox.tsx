import { Check, KeyRound } from 'lucide-react';
import { useRef, useState } from 'react';
import { copyToClipboard as copyText } from '../../shell/copy.ts';
import {
  SandboxOperation,
  SandboxOperations,
  startedOperation,
} from '../../ui/sandbox-operation.tsx';
import { CreateError, startSandbox } from '../create.ts';
import { mintKey, sandboxOfOperation } from '../sandbox-actions.ts';
import type { Sandbox } from '../session.ts';
import { verify } from '../turnstile.ts';

type Step = 'idle' | 'working' | 'reveal';

/** What the person copies once: the new sandbox and the key minted when its operation ended. */
interface Created {
  sandbox: Sandbox;
  secret: string;
}

/** "Create sandbox", then the key's one reveal: copied as .env, never drawn. */
export function CreateSandbox({
  csrf,
  siteKey,
  onReady,
}: {
  csrf: string;
  siteKey: string;
  onReady: (s: Sandbox) => void;
}) {
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Created | null>(null);
  const [op, setOp] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showCheck, setShowCheck] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  const create = async () => {
    setStep('working');
    setError(null);
    try {
      if (!siteKey || !host.current)
        throw new CreateError('The check is not available. Reload and try again.');
      host.current.replaceChildren();
      const token = await verify(host.current, siteKey, setShowCheck);
      const started = await startSandbox(csrf, token);
      startedOperation(started);
      setOp(started.id);
    } catch (e) {
      // One is already running (another tab, a reload): follow it instead of showing an error.
      if (e instanceof CreateError && e.operationId) setOp(e.operationId);
      else {
        setError(e instanceof CreateError ? e.message : 'The check did not pass. Try again.');
        setStep('idle');
      }
    }
  };

  /** The operation ended well: the key is minted once, here, and shown once. */
  const finish = (done: Parameters<typeof sandboxOfOperation>[0]) => {
    const sandbox = sandboxOfOperation(done);
    if (!sandbox) return;
    void mintKey(csrf)
      .catch(() => null)
      .then((secret) => {
        setOp(null);
        if (secret) {
          setMade({ sandbox, secret });
          setStep('reveal');
        } else onReady(sandbox);
      });
  };

  if (step === 'reveal' && made?.secret) {
    const tail = made.secret.slice(-4);
    return (
      <div className="reveal">
        <h3 className="h2">Your sandbox key</h3>
        <p className="muted sm">Shown once, and never on this page. Copy it into your .env.</p>
        <div className="reveal-key mono">
          <KeyRound aria-hidden="true" />
          PASSBOOK_KEY=pbp_test_••••••••{tail}
        </div>
        <div className="row g3 wrap-row">
          <button
            type="button"
            className="btn"
            onClick={() => void copyText(`PASSBOOK_KEY=${made.secret}\n`).then(setCopied)}
          >
            {copied ? <Check aria-hidden="true" /> : null}
            {copied ? 'Copied as .env' : 'Copy as .env'}
          </button>
          <button type="button" className="btn outline" onClick={() => onReady(made.sandbox)}>
            I saved it
          </button>
        </div>
        <p className="xs muted">The console runs with its own short-lived token, not this key.</p>
      </div>
    );
  }
  if (op)
    return (
      <SandboxOperations csrf={csrf}>
        <SandboxOperation
          id={op}
          onSucceeded={finish}
          onGone={() => {
            setOp(null);
            setStep('idle');
          }}
          onClose={() => {
            setOp(null);
            setStep('idle');
          }}
        />
      </SandboxOperations>
    );
  return (
    <div className="start">
      <button
        type="button"
        className="btn"
        disabled={step === 'working'}
        aria-busy={step === 'working'}
        onClick={() => void create()}
      >
        {step === 'working' ? 'Creating' : 'Create sandbox'}
      </button>
      {error ? (
        <p className="run-err" role="alert">
          {error}
        </p>
      ) : null}
      <div ref={host} className="check" data-shown={showCheck} />
    </div>
  );
}
