import { useRef, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { CreateError, createSandbox } from '../console/create.ts';
import type { Sandbox } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';
import { useSlow } from './use-clock.ts';

/** One button: the check, then the sandbox. A retry after a failure finishes what is missing, so it doubles as the repair. */
export function MakeSandbox({
  csrf,
  siteKey,
  label,
  onMade,
  autoFocus,
}: {
  csrf: string;
  siteKey: string;
  label: string;
  onMade: (sandbox: Sandbox, secret: string | null) => void;
  autoFocus?: boolean;
}) {
  const c = QS_COPY.steps.sandbox;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const slow = useSlow(working);

  const make = async () => {
    setWorking(true);
    setError(null);
    try {
      if (!siteKey || !host.current)
        throw new CreateError('The check is not available. Reload and try again.');
      host.current.replaceChildren();
      const token = await verify(host.current, siteKey, setShowCheck);
      const made = await createSandbox(csrf, token);
      onMade(made.sandbox, made.secret);
    } catch (e) {
      setError(e instanceof CreateError ? e.message : c.check);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="qs-make">
      <button
        type="button"
        className="btn"
        // biome-ignore lint/a11y/noAutofocus: the one action this step offers, after a sign-in redirect
        autoFocus={autoFocus}
        disabled={working}
        aria-busy={working}
        onClick={() => void make()}
      >
        {working ? c.working : label}
      </button>
      {error ? (
        <p className="run-err qs-err" role="alert">
          {error}
        </p>
      ) : null}
      {slow ? (
        <p className="xs qs-slow" role="note">
          {c.slow}
        </p>
      ) : null}
      <div ref={host} className="check" data-shown={showCheck} />
    </div>
  );
}
