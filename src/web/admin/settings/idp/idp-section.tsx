import { useCallback } from 'react';
import { useOperationParam } from '@/web/ui/operation/index.ts';
import { useIdpStatus } from '../../idp/status-queries.ts';
import { IdpCallsCard } from './idp-calls-card.tsx';
import { IdpDriftCard } from './idp-drift-card.tsx';
import { IdpOperation } from './idp-operation.tsx';
import { useIdpActions } from './idp-queries.ts';
import { IdpStatusCard } from './idp-status-card.tsx';
import { SetupCard } from './setup-card.tsx';

/**
 * Settings, Polaris ID: set up, status and the controls, an operation under way, the differences and the
 * calls ledger. Nothing shows while the binding is absent.
 */
export function IdpSection() {
  const status = useIdpStatus();
  const { refresh } = useIdpActions();
  const [op, setOp] = useOperationParam();
  const close = useCallback(() => setOp(null), [setOp]);
  if (!status.data?.connected) return null;
  return (
    <>
      <SetupCard busy={op !== null} onStarted={setOp} />
      <IdpStatusCard status={status.data} busy={op !== null} onStarted={setOp} />
      {op ? <IdpOperation id={op} onSucceeded={refresh} onClose={close} /> : null}
      <IdpDriftCard buddy={op === null} />
      <IdpCallsCard />
    </>
  );
}
