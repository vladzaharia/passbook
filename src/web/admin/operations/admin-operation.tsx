import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../../../generated/operations-kit.css';
import '../../styles/kit-controls.css';
import '../../styles/kit-motion.css';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/busy.css';
import '../../ui/art/scenes/cheer.css';
import '../../ui/art/scenes/sorry.css';
import { sessionOperationsClient } from '../../lib/operations-client.ts';
import {
  type Operation,
  OperationProgress,
  OperationsProvider,
  seedOperation,
  trackOperation,
  useOperation,
  useOperationActions,
  useOperations,
} from '../../ui/operation/index.ts';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';

/** The admin's operations client: the session's write token and the Test mode header. */
export function AdminOperations({ children }: { children: ReactNode }) {
  const client = useMemo(sessionOperationsClient, []);
  return <OperationsProvider client={client}>{children}</OperationsProvider>;
}

/**
 * One operation of an org action, live, inline where the action was started: the exact step with its count, every
 * step, Retry on the failed one. `onGone` runs when it cannot be read (not yours, or long gone), `onSucceeded`
 * once when it ends well.
 */
export function AdminOperation({
  id,
  orgId,
  framing = 'card',
  buddy = true,
  doneNote,
  next,
  onClose,
  onSucceeded,
  onGone,
}: {
  id: string;
  orgId: string;
  framing?: 'plain' | 'card';
  buddy?: boolean;
  doneNote?: (op: Operation) => ReactNode;
  next?: (op: Operation) => { label: string; onClick: () => void } | undefined;
  onClose?: () => void;
  onSucceeded?: (op: Operation) => void;
  onGone?: () => void;
}) {
  const zone = useOrgTimeZone(orgId);
  const { operation, missing } = useOperation(id);
  const { retry, retrying } = useOperationActions();
  const told = useRef<string | null>(null);
  const succeeded = operation?.status === 'succeeded' ? operation : null;
  useEffect(() => {
    if (!succeeded || told.current === `${succeeded.id}:${succeeded.attempt}`) return;
    told.current = `${succeeded.id}:${succeeded.attempt}`;
    onSucceeded?.(succeeded);
  }, [succeeded, onSucceeded]);
  useEffect(() => {
    if (missing) onGone?.();
  }, [missing, onGone]);
  if (!operation) return null;
  const note = doneNote?.(operation);
  const action = next?.(operation);
  return (
    <OperationProgress
      operation={operation}
      framing={framing}
      buddy={buddy}
      zone={zone}
      {...(note ? { doneNote: note } : {})}
      {...(action ? { next: action } : {})}
      {...(onClose ? { onClose } : {})}
      onRetry={() => void retry(operation)}
      retrying={retrying}
    />
  );
}

/**
 * The operation an action shows: the one just started (`show(id)` from the start's answer) or, after a reload, the
 * org's active one of this kind (a platform kind passes no org). `clear` leaves a finished panel. Reads through the session client, so an
 * org's row (not the person's own) is found by org and kind.
 */
export function useOrgOperation(kind: string, orgId: string | undefined) {
  const [id, setId] = useState<string | null>(null);
  const resumed = useOperations({ active: true, kind, ...(orgId ? { orgId } : {}) });
  useEffect(() => {
    if (id) return;
    const active = resumed.operations[0];
    if (active) setId(active.id);
  }, [id, orgId, resumed.operations]);
  const show = useCallback((next: string | null | undefined) => {
    if (next) setId(next);
  }, []);
  const clear = useCallback(() => setId(null), []);
  return { id, show, clear, seed: seedOperation };
}

/**
 * An action whose dialog closes puts its operation into the tray: the person's own row, read once by id (the start's
 * answer names it only). The tray polls it and tells the person when it ends.
 */
export async function trackStarted(id: string): Promise<void> {
  const { operation } = await sessionOperationsClient().get(id, {});
  if (operation) trackOperation(operation);
}
