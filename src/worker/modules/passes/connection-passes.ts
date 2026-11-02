import type { Personalization } from '../../../passkit/types.ts';
import { strictEmail } from '../../../shared/email.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assignHolder } from '../holders/service.ts';
import { createPassRow } from './create.ts';
import { type Mutation, publishPass } from './publish.ts';
import {
  connectionGeneration,
  type FieldSources,
  findByConnectionRef,
  getPass,
  setSyncError,
} from './repo.ts';

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
  ctx: ServiceContext,
  input: ConnectionRecordInput,
): Promise<{ changed: boolean; version: number }> {
  const db = ctx.env.DB;
  const pass = await getPass(db, input.passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (pass.connectionId !== input.connectionId)
    throw new ConflictError(
      'The pass is not linked to this connection.',
      'PASS_CONNECTION_MISMATCH',
    );
  if ((await connectionGeneration(db, input.connectionId)) !== input.generation) {
    ctx.log.info('pass.apply_fenced', { passId: pass.id, connectionId: input.connectionId });
    return { changed: false, version: pass.version };
  }
  const result = await publishPass(ctx, {
    passId: input.passId,
    cause: input.cause,
    actor: { type: 'connection', id: input.connectionId },
    mutate: (current): Mutation => {
      const personalization: Personalization = { ...current.personalization };
      const fieldSources: FieldSources = { ...current.fieldSources };
      for (const [key, value] of Object.entries(input.fields)) {
        if (current.fieldSources[key] === 'manual') continue;
        personalization[key] = value;
        fieldSources[key] = 'connection';
      }
      return { personalization, fieldSources };
    },
  });
  if (result.pass.syncErrorCode) await setSyncError(db, pass.id, null);
  const email = input.holderEmail ? strictEmail(input.holderEmail) : null;
  if (input.holderEmail && !email)
    ctx.log.warn('pass.holder_email_invalid', { passId: pass.id, code: 'EMAIL_INVALID' });
  // Unchanged emails would cost an audit row and hook A on every sync.
  if (email && !result.pass.ownerUserId && email !== result.pass.holderEmail) {
    await assignHolder(
      ctx,
      { type: 'connection', id: input.connectionId },
      { passId: pass.id, email },
      null,
    );
  }
  return { changed: result.changed, version: result.pass.version };
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

/** Idempotent per (connection, externalRef): an existing pass is returned unchanged. */
export async function createPassFromConnection(
  ctx: ServiceContext,
  input: CreateFromConnectionInput,
): Promise<{ passId: string }> {
  const existing = await findByConnectionRef(
    ctx.env.DB,
    input.orgId,
    input.connectionId,
    input.externalRef,
  );
  if (existing) return { passId: existing };
  try {
    const pass = await createPassRow(ctx, {
      orgId: input.orgId,
      templateId: input.templateId,
      input: input.fields,
      holderEmail: input.holderEmail ?? null,
      connectionId: input.connectionId,
      externalRef: input.externalRef,
      sendEmail: input.sendEmail,
      source: 'connection',
      actor: { type: 'connection', id: input.connectionId },
    });
    return { passId: pass.id };
  } catch (error) {
    // A concurrent sync won the unique (connection, ref) index: use its pass, send no email.
    if (!(error instanceof ConflictError) || error.code !== 'PASS_REF_TAKEN') throw error;
    const winner = await findByConnectionRef(
      ctx.env.DB,
      input.orgId,
      input.connectionId,
      input.externalRef,
    );
    if (!winner) throw error;
    return { passId: winner };
  }
}

/** Upstream record missing: `flag` sets sync_error_code RECORD_MISSING; `void` voids the pass. */
export async function markPassMissing(
  ctx: ServiceContext,
  passId: string,
  mode: 'flag' | 'void',
): Promise<void> {
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (mode === 'void' && pass.status === 'active') {
    await publishPass(ctx, {
      passId,
      cause: 'connection',
      actor: { type: 'connection', id: pass.connectionId },
      mutate: () => ({ status: 'voided' }),
    });
  }
  // After the publish, which clears the error column.
  await setSyncError(ctx.env.DB, passId, 'RECORD_MISSING');
}
