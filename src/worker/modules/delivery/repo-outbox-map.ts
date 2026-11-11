export type OutboxState =
  | 'pending'
  | 'enqueued'
  | 'processing'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface OutboxRow {
  id: string;
  orgId: string;
  kind: 'push' | 'email';
  passId: string | null;
  payload: Record<string, unknown>;
  state: OutboxState;
  attempts: number;
  maxAttempts: number;
  lease: string | null;
  errorCode: string | null;
  providerId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface OutboxDbRow {
  id: string;
  org_id: string;
  kind: 'push' | 'email';
  pass_id: string | null;
  payload: string;
  state: OutboxState;
  attempts: number;
  max_attempts: number;
  lease: string | null;
  error_code: string | null;
  provider_id: string | null;
  created_at: number;
  finished_at: number | null;
}

export const mapOutbox = (r: OutboxDbRow): OutboxRow => ({
  id: r.id,
  orgId: r.org_id,
  kind: r.kind,
  passId: r.pass_id,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  state: r.state,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  lease: r.lease,
  errorCode: r.error_code,
  providerId: r.provider_id,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});
