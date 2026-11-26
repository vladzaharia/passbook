import { type ReactNode, useEffect } from 'react';
import type { Operation } from '../../ui/operation/index.ts';
import { AdminOperation, AdminOperations, useOrgOperation } from './admin-operation.tsx';

/**
 * Where a page shows the operation of one action: the one just started (`startedId`, from the start's answer),
 * else the active one of its kind, found again after a reload. Draws nothing when there is none.
 */
export function OperationSlot({
  kind,
  orgId,
  startedId,
  onClear,
  doneNote,
  next,
  framing = 'card',
  onSucceeded,
}: {
  kind: string;
  orgId?: string;
  startedId: string | null | undefined;
  onClear?: () => void;
  doneNote?: (op: Operation) => ReactNode;
  next?: (op: Operation) => { label: string; onClick: () => void } | undefined;
  framing?: 'plain' | 'card';
  onSucceeded?: (op: Operation) => void;
}) {
  return (
    <AdminOperations>
      <Slot
        kind={kind}
        startedId={startedId}
        framing={framing}
        {...(orgId ? { orgId } : {})}
        {...(onClear ? { onClear } : {})}
        {...(doneNote ? { doneNote } : {})}
        {...(next ? { next } : {})}
        {...(onSucceeded ? { onSucceeded } : {})}
      />
    </AdminOperations>
  );
}

function Slot({
  kind,
  orgId,
  startedId,
  onClear,
  doneNote,
  next,
  framing,
  onSucceeded,
}: {
  kind: string;
  orgId?: string;
  startedId: string | null | undefined;
  onClear?: () => void;
  doneNote?: (op: Operation) => ReactNode;
  next?: (op: Operation) => { label: string; onClick: () => void } | undefined;
  framing: 'plain' | 'card';
  onSucceeded?: (op: Operation) => void;
}) {
  const { id, show, clear } = useOrgOperation(kind, orgId);
  useEffect(() => show(startedId), [startedId, show]);
  if (!id) return null;
  const leave = () => {
    clear();
    onClear?.();
  };
  return (
    <div className="mb-6">
      <AdminOperation
        id={id}
        orgId={orgId ?? ''}
        framing={framing}
        onClose={leave}
        onGone={leave}
        {...(doneNote ? { doneNote } : {})}
        {...(next ? { next } : {})}
        {...(onSucceeded ? { onSucceeded } : {})}
      />
    </div>
  );
}
