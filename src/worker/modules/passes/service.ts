import type { Personalization } from '../../../passkit/types.ts';
import { NotImplementedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** Workstream d owns this module; e, f and others call these. Keep the signatures. */
export interface Actor {
  type: 'user' | 'api_key' | 'system' | 'connection';
  id: string | null;
}

/** Claims `refresh_requested_at` (coalescing window from settings) and enqueues a `pass.refresh` job. */
export async function requestRefresh(
  _ctx: ServiceContext,
  _passId: string,
  _actor: Actor,
): Promise<{ requestedAt: number; coalesced: boolean }> {
  throw new NotImplementedError('passes.requestRefresh');
}

export interface ConnectionRecordInput {
  passId: string;
  connectionId: string;
  /** Connection generation at run start; stale runs are fenced. */
  generation: number;
  /** Mapped template inputs. Fields marked `manual` in field_sources are skipped. */
  fields: Personalization;
  holderEmail?: string | null;
  cause: 'connection' | 'user_refresh';
}

/** Applies upstream data; publishes only if the built pass changed. */
export async function applyConnectionRecord(
  _ctx: ServiceContext,
  _input: ConnectionRecordInput,
): Promise<{ changed: boolean; version: number }> {
  throw new NotImplementedError('passes.applyConnectionRecord');
}

export interface CreateFromConnectionInput {
  orgId: string;
  templateId: string;
  connectionId: string;
  externalRef: string;
  fields: Personalization;
  holderEmail?: string | null;
  sendEmail: boolean;
}

export async function createPassFromConnection(
  _ctx: ServiceContext,
  _input: CreateFromConnectionInput,
): Promise<{ passId: string }> {
  throw new NotImplementedError('passes.createPassFromConnection');
}

/** Upstream record missing: `flag` sets sync_error_code RECORD_MISSING; `void` voids the pass. */
export async function markPassMissing(
  _ctx: ServiceContext,
  _passId: string,
  _mode: 'flag' | 'void',
): Promise<void> {
  throw new NotImplementedError('passes.markPassMissing');
}
