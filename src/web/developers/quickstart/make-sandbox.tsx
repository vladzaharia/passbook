import { useCallback, useRef, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { CreateError, startSandbox } from '../console/create.ts';
import { mintKey, sandboxOfOperation } from '../console/sandbox-actions.ts';
import type { Sandbox } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';
import { SandboxOperation, startedOperation } from '../ui/sandbox-operation.tsx';

/**
 * The create operation, live and inline: every step with its count, Retry on the one that failed. When it ends well
 * the key is minted once and handed to the page; a person who had left gets "Show key" instead.
 */
export function CreatePanel({
  csrf,
  id,
  onMade,
  onOp,
}: {
  csrf: string;
  id: string;
  onMade: (sandbox: Sandbox, secret: string | null) => void;
  onOp: (id: string | null) => void;
}) {
  const finish = useCallback(
    (op: Parameters<typeof sandboxOfOperation>[0]) => {
      const sandbox = sandboxOfOperation(op);
      if (!sandbox) return;
      // A key that cannot be minted now is offered again as "Show key": the sandbox itself is made.
      void mintKey(csrf)
        .catch(() => null)
        .then((secret) => {
          onMade(sandbox, secret);
          onOp(null);
        });
    },
    [csrf, onMade, onOp],
  );
  return (
    <SandboxOperation
      id={id}
      framing="card"
      onSucceeded={finish}
      onGone={() => onOp(null)}
      onClose={() => onOp(null)}
    />
  );
}

/** One button: the check, then the operation. Starting again after a failure finishes what is missing. */
export function MakeSandbox({
  csrf,
  siteKey,
  label,
  onMade,
  op,
  onOp,
  autoFocus,
}: {
  csrf: string;
  siteKey: string;
  label: string;
  onMade: (sandbox: Sandbox, secret: string | null) => void;
  /** The operation under way (`?sandbox-op=`), if any: it replaces the button. */
  op: string | null;
  onOp: (id: string | null) => void;
  autoFocus?: boolean;
}) {
  const c = QS_COPY.steps.sandbox;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  const make = async () => {
    setWorking(true);
    setError(null);
    try {
      if (!siteKey || !host.current)
        throw new CreateError('The check is not available. Reload and try again.');
      host.current.replaceChildren();
      const token = await verify(host.current, siteKey, setShowCheck);
      const started = await startSandbox(csrf, token);
      startedOperation(started);
      onOp(started.id);
    } catch (e) {
      // One is already running (another tab, a reload): follow it instead of showing an error.
      if (e instanceof CreateError && e.operationId) onOp(e.operationId);
      else setError(e instanceof CreateError ? e.message : c.check);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="qs-make">
      {op ? (
        <CreatePanel csrf={csrf} id={op} onMade={onMade} onOp={onOp} />
      ) : (
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
      )}
      {error ? (
        <p className="run-err qs-err" role="alert">
          {error}
        </p>
      ) : null}
      <div ref={host} className="check" data-shown={showCheck} />
    </div>
  );
}
