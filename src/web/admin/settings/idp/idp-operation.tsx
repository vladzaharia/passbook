import { useEffect, useMemo, useRef } from 'react';
import { sessionOperationsClient } from '@/web/lib/operations-client.ts';
import {
  OperationProgress,
  OperationsProvider,
  useClaimOperation,
  useOperation,
  useOperationActions,
} from '@/web/ui/operation/index.ts';

/** One Polaris ID operation, live inline: the page owns its `?op`, so the tray opens no sheet for it. */
export function IdpOperation({
  id,
  onSucceeded,
  onClose,
}: {
  id: string;
  /** Runs once when it ends well: the page refreshes what it changed. */
  onSucceeded: () => void;
  onClose: () => void;
}) {
  const client = useMemo(sessionOperationsClient, []);
  return (
    <OperationsProvider client={client}>
      <Panel id={id} onSucceeded={onSucceeded} onClose={onClose} />
    </OperationsProvider>
  );
}

function Panel({
  id,
  onSucceeded,
  onClose,
}: {
  id: string;
  onSucceeded: () => void;
  onClose: () => void;
}) {
  useClaimOperation(id);
  const { operation, missing } = useOperation(id);
  const { retry, retrying } = useOperationActions();
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (operation?.status !== 'succeeded' || told.current === operation.id) return;
    told.current = operation.id;
    onSucceeded();
  }, [operation, onSucceeded]);
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (!operation) return null;
  return (
    <OperationProgress
      operation={operation}
      onRetry={() => void retry(operation)}
      retrying={retrying}
      onClose={onClose}
    />
  );
}
