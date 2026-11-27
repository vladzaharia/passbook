import { CircleAlert, CircleCheck, Lock, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { type Draft, type InputCheck, inputUnchecked } from '../request.ts';
import type { RunOp } from '../types.ts';
import type { Issue } from '../validate.ts';

const C = CONSOLE_COPY.run;
const CONFIRM_MS = 4000;

/**
 * Validity on the left, Run on the right. A destructive operation asks twice: the first press arms
 * "Confirm", which lapses after four seconds. `pressRef` is the Cmd/Ctrl+Enter path, the same gate.
 */
export function RunBar({
  op,
  draft,
  check,
  issues,
  pending,
  spent,
  run,
  pressRef,
  reason,
  ask,
}: {
  op: RunOp;
  draft: Draft;
  check?: InputCheck | undefined;
  issues: Issue[];
  pending: boolean;
  spent: boolean;
  run: () => void;
  pressRef: { current: (() => void) | null };
  /** Why this operation cannot run here: Run stays disabled and the line says why. */
  reason?: string | null | undefined;
  /** The Workbench asks in a dialog before a destructive call; elsewhere the button arms. */
  ask?: (() => void) | undefined;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const blocked = issues.length > 0 || pending || spent || Boolean(reason);
  const press = () => {
    if (blocked) return;
    if (op.destructive && ask) return ask();
    if (op.destructive && !armed) return setArmed(true);
    setArmed(false);
    run();
  };
  pressRef.current = press;
  return (
    <div className="runbar">
      <span className="valid" data-ok={issues.length === 0 && !reason}>
        {reason ? (
          <>
            <Lock aria-hidden="true" />
            {reason}
          </>
        ) : issues.length === 0 ? (
          <>
            <CircleCheck aria-hidden="true" />
            {op.body ? (inputUnchecked(op, draft, check) ? C.shape : C.valid) : C.ready}
          </>
        ) : (
          <details>
            <summary>
              <CircleAlert aria-hidden="true" />
              {C.problems(issues.length)}
            </summary>
            <ul>
              {issues.slice(0, 8).map((i) => (
                <li key={`${i.path}${i.message}`}>
                  <span className="mono">{i.path || 'body'}</span> {i.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </span>
      <button
        type="button"
        className={`btn run${armed ? ' danger' : ''}`}
        disabled={blocked}
        aria-busy={pending}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        onClick={press}
      >
        {pending ? <span className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
        {armed ? C.confirm(op.method.toUpperCase()) : pending ? C.running : spent ? C.wait : C.run}
        {armed || pending ? null : (
          <span className="kbd" aria-hidden="true">
            ⌘↵
          </span>
        )}
      </button>
    </div>
  );
}
