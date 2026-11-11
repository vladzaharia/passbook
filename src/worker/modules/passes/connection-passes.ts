import type { Personalization } from '../../../passkit/types.ts';
import { strictEmail } from '../../../shared/email.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { createPassRow } from './create.ts';
import { type Mutation, publishPass } from './publish.ts';
import {
  applyConnectionState,
  connectionForPass,
  type ConnectionPassContext,
  type FieldSources,
  findByConnectionRef,
  getPass,
  matchesConnectionPass,
  validConnectionPassContext,
} from './repo.ts';

export interface ConnectionRecordInput extends ConnectionPassContext {
  /** Mapped template inputs. Fields marked `manual` in field_sources are skipped. */
  fields: Personalization;
  holderEmail?: string | null;
  cause: 'connection' | 'user_refresh';
}

const stalePass = () => new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');

async function checkedPass(ctx: ServiceContext, context: ConnectionPassContext) {
  if (!validConnectionPassContext(context)) throw stalePass();
  const pass = await getPass(ctx.env.DB, context.passId);
  if (!pass) throw stalePass();
  if (
    pass.orgId !== context.orgId || pass.mode !== context.mode ||
    pass.connectionId !== context.connectionId || pass.externalRef !== context.externalRef
  )
    throw new ConflictError('The pass is not linked to this connection.', 'PASS_CONNECTION_MISMATCH');
  if (!(await matchesConnectionPass(ctx.env.DB, context))) throw stalePass();
  return pass;
}

/** Applies upstream data; publishes only if the built pass changed. */
export async function applyConnectionRecord(
  ctx: ServiceContext,
  input: ConnectionRecordInput,
): Promise<{ changed: boolean; version: number; ownerUserId: string | null; linkGeneration: number }> {
  const pass = await checkedPass(ctx, input);
  const email = input.holderEmail ? strictEmail(input.holderEmail) : null;
  if (input.holderEmail && !email)
    ctx.log.warn('pass.holder_email_invalid', { passId: pass.id, code: 'EMAIL_INVALID' });
  const holderChange = email && !pass.ownerUserId && email !== pass.holderEmail
    ? { email, token: ctx.ids.token(), now: ctx.clock.now() }
    : null;
  if (holderChange?.token === pass.downloadToken)
    throw new ConflictError('The download link could not be rotated.', 'PASS_CONFLICT');
  const result = await publishPass(ctx, {
    passId: input.passId,
    cause: input.cause,
    actor: { type: 'connection', id: input.connectionId },
    connectionContext: input,
    expectedHolder: pass,
    connectionState: { syncErrorCode: null, holderChange },
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
  if (result.pass.holderEmail !== pass.holderEmail) {
    await recordAudit(ctx, {
      orgId: pass.orgId,
      actorType: 'connection',
      actorId: input.connectionId,
      action: 'holder.assign',
      targetType: 'pass',
      targetId: pass.id,
      detail: { changed: true },
    });
    if (result.pass.ownerUserId) {
      await recordAudit(ctx, {
        orgId: pass.orgId,
        actorType: 'connection',
        actorId: input.connectionId,
        action: 'holder.attach',
        targetType: 'pass',
        targetId: pass.id,
        detail: { via: 'email', userId: result.pass.ownerUserId },
      });
    }
  }
  return {
    changed: result.changed,
    version: result.pass.version,
    ownerUserId: result.pass.ownerUserId,
    linkGeneration: result.pass.linkGeneration,
  };
}

export interface CreateFromConnectionInput {
  orgId: string;
  mode: 'live';
  templateId: string;
  templateVersion: string;
  generation: number;
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
  if (
    input.mode !== 'live' || !input.orgId || !input.templateId || !input.templateVersion ||
    !input.connectionId || !input.externalRef ||
    !Number.isSafeInteger(input.generation) || input.generation < 1
  )
    throw stalePass();
  const connection = await connectionForPass(ctx.env.DB, input.connectionId, input.orgId, 'live');
  if (!connection)
    throw new ConflictError('The connection is unavailable.', 'PASS_CONNECTION_MISMATCH');
  if (connection.generation !== input.generation) throw stalePass();
  const eligibleWinner = async (passId: string): Promise<string> => {
    const pass = await getPass(ctx.env.DB, passId);
    if (
      !pass || pass.status !== 'active' || pass.mode !== 'live' ||
      pass.orgId !== input.orgId || pass.connectionId !== input.connectionId ||
      pass.externalRef !== input.externalRef ||
      !(await matchesConnectionPass(ctx.env.DB, {
        passId, orgId: input.orgId, mode: 'live', status: 'active',
        expectedVersion: pass.version, connectionId: input.connectionId,
        ownerUserId: pass.ownerUserId, linkGeneration: pass.linkGeneration,
        externalRef: input.externalRef, generation: input.generation,
      }))
    )
      throw new ConflictError('The existing pass cannot be synchronized.', 'PASS_CONNECTION_MISMATCH');
    return passId;
  };
  const existing = await findByConnectionRef(
    ctx.env.DB,
    input.orgId,
    input.connectionId,
    input.externalRef,
  );
  if (existing) return { passId: await eligibleWinner(existing) };
  try {
    const pass = await createPassRow(ctx, {
      orgId: input.orgId,
      templateId: input.templateId,
      mode: input.mode,
      templateVersion: input.templateVersion,
      connectionGeneration: input.generation,
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
    return { passId: await eligibleWinner(winner) };
  }
}

/** Upstream record missing: flag or void only the exact pass that was fetched. */
export async function markPassMissing(
  ctx: ServiceContext,
  context: ConnectionPassContext,
  mode: 'flag' | 'void',
): Promise<{ version: number; ownerUserId: string | null; linkGeneration: number }> {
  const pass = await checkedPass(ctx, context);
  if (mode === 'void' && context.status === 'active') {
    const result = await publishPass(ctx, {
      passId: context.passId,
      cause: 'connection',
      actor: { type: 'connection', id: context.connectionId },
      connectionContext: context,
      expectedHolder: pass,
      connectionState: { syncErrorCode: 'RECORD_MISSING', holderChange: null },
      mutate: () => ({ status: 'voided' }),
    });
    return {
      version: result.pass.version,
      ownerUserId: result.pass.ownerUserId,
      linkGeneration: result.pass.linkGeneration,
    };
  }
  const state = await applyConnectionState(ctx.env.DB, context, pass, 'RECORD_MISSING');
  if (!state) throw stalePass();
  return { version: state.version, ownerUserId: state.ownerUserId, linkGeneration: state.linkGeneration };
}
