import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { WB_SANDBOX_COPY } from '@/shared/copy/workbench-sandbox.ts';
import { useSession } from '../../lib/session.ts';
import { ConfirmDialog } from '../../ui/alert-dialog.tsx';
import { createFetchClient, OperationsProvider } from '../../ui/operation/index.ts';
import { useToolHost } from '../host/tool-host.tsx';
import { useFollowEnd } from './follow.ts';
import {
  ACT_COPY,
  type Act,
  RESUME_KEY,
  type Refusal,
  RunningError,
  refusalOf,
  startAct,
} from './lifecycle.ts';

/**
 * One sandbox action's confirm (the switcher's Danger group and the Sandbox page share it): the
 * consequence, the check, then the call. The page follows the operation to its end (`useFollowEnd`). Loads only when an action is chosen.
 */
function Danger({
  act,
  followId,
  onDone,
  onStarted,
}: {
  act: Act | null;
  /** An operation started elsewhere (a reload) to follow to its end. */
  followId?: string | null;
  onDone: () => void;
  onStarted?: (id: string) => void;
}) {
  const host = useToolHost();
  const queries = useQueryClient();
  const [started, setStarted] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useFollowEnd(started ?? followId ?? null, host.context.orgId);
  if (!act) return null;
  const copy = ACT_COPY[act];
  const run = async () => {
    setRefusal(null);
    try {
      const op = await startAct(act, slot, setShowCheck);
      setStarted(op.id);
      onStarted?.(op.id);
      void queries.invalidateQueries({ queryKey: ['workbench', 'summary'] });
    } catch (e) {
      if (e instanceof RunningError) {
        setStarted(e.operationId);
        onStarted?.(e.operationId);
        return;
      }
      setRefusal(refusalOf(e));
      throw e;
    }
  };
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onDone()}
      title={copy.title}
      description={
        <>
          {copy.description}
          {refusal?.signInUrl ? (
            <a
              className="mt-2 block text-accent-fg underline"
              href={refusal.signInUrl}
              onClick={() => {
                try {
                  sessionStorage.setItem(RESUME_KEY, act);
                } catch {
                  // The confirm just will not reopen after the sign-in.
                }
              }}
            >
              {WB_SANDBOX_COPY.signInAgain}
            </a>
          ) : null}
          <div ref={setSlot} className={showCheck ? 'mt-3' : 'h-0 overflow-hidden'} />
        </>
      }
      confirmLabel={copy.confirmLabel}
      destructive
      onConfirm={run}
    />
  );
}

/** The sandbox's own operations are the person's (starter rows): read with the session, never the Workbench token. */
export default function SandboxDanger(props: Parameters<typeof Danger>[0]) {
  const csrf = useSession().authed?.csrfToken ?? '';
  const client = useMemo(() => createFetchClient({ csrf: async () => csrf }), [csrf]);
  return (
    <OperationsProvider client={client}>
      <Danger {...props} />
    </OperationsProvider>
  );
}
