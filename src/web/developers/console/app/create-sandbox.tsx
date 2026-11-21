import { Check, KeyRound } from 'lucide-react';
import { useRef, useState } from 'react';
import { copyToClipboard as copyText } from '../../shell/copy.ts';
import { type Created, CreateError, createSandbox } from '../create.ts';
import type { Sandbox } from '../session.ts';
import { verify } from '../turnstile.ts';

type Step = 'idle' | 'working' | 'reveal';

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
      const result = await createSandbox(csrf, token);
      if (result.secret) {
        setMade(result);
        setStep('reveal');
      } else onReady(result.sandbox);
    } catch (e) {
      setError(e instanceof CreateError ? e.message : 'The check did not pass. Try again.');
      setStep('idle');
    }
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
  return (
    <div className="start">
      <h3 className="h2">No sandbox yet</h3>
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
