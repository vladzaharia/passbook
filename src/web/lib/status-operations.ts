import { Ban, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import type { OperationStatus } from '../../shared/contracts/operations.ts';
import type { StatusEntry } from './status.ts';

export type { OperationStatus };

/**
 * Operation states. The API says `succeeded` and `cancelled`; people read Done and Stopped:
 * "Cancel" in a dialog means close without doing it, and work that was done stays done.
 */
export const OPERATION_STATUS = {
  queued: { label: 'Queued', tone: 'neutral', icon: Clock },
  running: { label: 'Running', tone: 'info', icon: Loader2, spin: true },
  waiting: { label: 'Waiting', tone: 'info', icon: Clock },
  succeeded: { label: 'Done', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  cancelled: { label: 'Stopped', tone: 'neutral', icon: Ban },
} as const satisfies Record<OperationStatus, StatusEntry>;

export const isOperationActive = (status: OperationStatus): boolean =>
  status === 'queued' || status === 'running' || status === 'waiting';
