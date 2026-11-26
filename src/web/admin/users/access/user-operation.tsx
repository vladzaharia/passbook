import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { sessionOperationsClient } from '@/web/lib/operations-client.ts';
import {
  OperationProgress,
  OperationsProvider,
  useClaimOperation,
  useOperation,
  useOperationActions,
} from '@/web/ui/operation/index.ts';

function Panel({ id, onClose }: { id: string; onClose: () => void }) {
  useClaimOperation(id);
  const client = useQueryClient();
  const { operation, missing } = useOperation(id);
  const { retry, retrying, stop } = useOperationActions();
  const told = useRef<string | null>(null);
  const done = operation?.status === 'succeeded';
  useEffect(() => {
    if (!done || told.current === id) return;
    told.current = id;
    void client.invalidateQueries({ queryKey: ['idp'] });
    void client.invalidateQueries({ queryKey: ['users'] });
  }, [done, id, client]);
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (!operation) return null;
  return (
    <OperationProgress
      framing="card"
      operation={operation}
      retrying={retrying}
      onStop={() => stop(operation)}
      onRetry={() => retry(operation)}
      onClose={onClose}
    />
  );
}

/** The Restore or Offboard run the page's `?op` names, live in place; it claims the id so the tray opens no second sheet. */
export function UserOperation({ id, onClose }: { id: string | null; onClose: () => void }) {
  const client = useMemo(sessionOperationsClient, []);
  if (!id) return null;
  return (
    <OperationsProvider client={client}>
      <Panel id={id} onClose={onClose} />
    </OperationsProvider>
  );
}
