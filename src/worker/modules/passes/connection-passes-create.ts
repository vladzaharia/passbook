import type { Personalization } from '../../../passkit/types.ts';
import {
  type ConnectionMode,
  ConnectionModeSchema,
} from '../../../shared/contracts/connections.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { retainedWebhookRefHash } from '../connections/webhook-claim-ref.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { stalePass } from './connection-passes-context.ts';
import { createPassRow } from './create.ts';
import { requireCredentialRefKeyset } from './credential-keyset.ts';
import {
  captureConnectionTransferPending,
  connectionForPass,
  findByConnectionRef,
  matchesConnectionPass,
} from './repo-read-connection.ts';
import { getPass } from './repo-read-pass.ts';
import { matchesRetainedIssuanceClaim, type RetainedIssuanceClaim } from './repo-write-retained.ts';

export interface CreateFromConnectionInput {
  orgId: string;
  mode: 'live';
  templateId: string;
  /** The approved release observed at the start of this polling/webhook retry. */
  expectedRelease: { id: string; generation: number; version: string } | null;
  generation: number;
  credentialKeysetCommitment: string;
  /** The connection strategy captured before this work began. */
  expectedConnectionMode: ConnectionMode;
  connectionId: string;
  /** Worker-only issuance identity reserved by a durable webhook item. */
  reservedPassId?: string;
  retainedClaim?: RetainedIssuanceClaim;
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
  input = structuredClone(input);
  if (
    input.mode !== 'live' ||
    !input.orgId ||
    !input.templateId ||
    !input.connectionId ||
    !input.externalRef ||
    typeof input.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.credentialKeysetCommitment) ||
    (input.reservedPassId !== undefined &&
      (typeof input.reservedPassId !== 'string' || !input.reservedPassId)) ||
    (input.reservedPassId === undefined) !== (input.retainedClaim === undefined) ||
    (input.retainedClaim !== undefined &&
      (!input.expectedRelease ||
        (input.expectedConnectionMode !== 'webhook' &&
          input.expectedConnectionMode !== 'hybrid'))) ||
    (input.retainedClaim !== undefined &&
      (input.retainedClaim === null ||
        typeof input.retainedClaim !== 'object' ||
        typeof input.retainedClaim.refHash !== 'string')) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !ConnectionModeSchema.options.includes(input.expectedConnectionMode) ||
    (input.expectedRelease !== null &&
      (!input.expectedRelease?.id ||
        !input.expectedRelease.version ||
        !Number.isSafeInteger(input.expectedRelease.generation) ||
        input.expectedRelease.generation < 1))
  )
    throw stalePass();
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== input.credentialKeysetCommitment)
    throw stalePass();
  if (input.retainedClaim) {
    const captured = await retainedWebhookRefHash(
      ctx,
      input.orgId,
      input.connectionId,
      input.externalRef,
    );
    if (
      input.retainedClaim.refHash !== captured.refHash ||
      input.retainedClaim.credentialKeysetCommitment !== captured.credentialKeysetCommitment
    )
      throw stalePass();
    if (captured.credentialKeysetCommitment !== input.credentialKeysetCommitment) throw stalePass();
  }
  const connection = await connectionForPass(
    ctx.env.DB,
    input.connectionId,
    input.orgId,
    'live',
    input.expectedConnectionMode,
  );
  if (!connection)
    throw new ConflictError('The connection is unavailable.', 'PASS_CONNECTION_MISMATCH');
  if (connection.generation !== input.generation) throw stalePass();
  const admittedConnectionMode = connection.mode;
  const eligibleWinner = async (passId: string): Promise<string> => {
    if (input.reservedPassId !== undefined && input.reservedPassId !== passId)
      throw new ConflictError(
        'Another pass already uses this connection reference.',
        'PASS_CONFLICT',
      );
    const pass = await getPass(ctx.env.DB, passId);
    if (!pass || (await captureConnectionTransferPending(ctx.env.DB, pass)) !== false)
      throw stalePass();
    if (input.retainedClaim && input.expectedRelease && input.expectedConnectionMode) {
      const approved = await requireApprovedRelease(
        ctx,
        input.templateId,
        input.orgId,
        input.mode,
        'apple',
      );
      if (
        approved.provider !== 'apple' ||
        approved.id !== input.expectedRelease.id ||
        approved.generation !== input.expectedRelease.generation ||
        approved.version !== input.expectedRelease.version ||
        pass.version !== 1 ||
        pass.linkGeneration !== 1 ||
        pass.credentialGeneration !== 1 ||
        pass.lifecycleGeneration !== 0 ||
        pass.templateId !== input.templateId ||
        pass.releaseId !== approved.id ||
        pass.templateVersion !== approved.version ||
        !(await matchesRetainedIssuanceClaim(ctx.env.DB, {
          claim: input.retainedClaim,
          passId,
          orgId: input.orgId,
          connectionId: input.connectionId,
          connectionGeneration: input.generation,
          connectionMode: input.expectedConnectionMode,
          templateId: input.templateId,
          release: {
            id: approved.id,
            generation: approved.generation,
            orgId: approved.orgId,
            candidateHash: approved.candidateHash,
            provider: 'apple',
          },
          releaseVersion: approved.version,
        }))
      )
        throw stalePass();
    }
    if (
      pass.status !== 'active' ||
      pass.mode !== 'live' ||
      pass.orgId !== input.orgId ||
      pass.connectionId !== input.connectionId ||
      pass.externalRef !== input.externalRef ||
      !(await matchesConnectionPass(ctx.env.DB, {
        passId,
        orgId: input.orgId,
        mode: 'live',
        status: 'active',
        expectedVersion: pass.version,
        expectedRowVersion: pass.rowVersion,
        connectionId: input.connectionId,
        ownerUserId: pass.ownerUserId,
        linkGeneration: pass.linkGeneration,
        identityId: pass.identityId,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        credentialKeysetCommitment: input.credentialKeysetCommitment,
        transferPending: false,
        externalRef: input.externalRef,
        generation: input.generation,
        expectedConnectionMode: admittedConnectionMode,
      }))
    )
      throw new ConflictError(
        'The existing pass cannot be synchronized.',
        'PASS_CONNECTION_MISMATCH',
      );
    return passId;
  };
  const existing = await findByConnectionRef(
    ctx.env.DB,
    input.orgId,
    input.connectionId,
    input.externalRef,
  );
  if (existing) return { passId: await eligibleWinner(existing) };
  if (!input.expectedRelease)
    throw new ConflictError('An approved Apple release is required.', 'TEMPLATE_RELEASE_REQUIRED');
  try {
    const release = await requireApprovedRelease(
      ctx,
      input.templateId,
      input.orgId,
      input.mode,
      'apple',
    );
    if (
      release.id !== input.expectedRelease.id ||
      release.generation !== input.expectedRelease.generation ||
      release.version !== input.expectedRelease.version
    )
      throw new ConflictError(
        'The approved release changed. Retry the connection.',
        'TEMPLATE_RELEASE_CONFLICT',
      );
    const pass = await createPassRow(ctx, {
      ...(input.reservedPassId === undefined || input.retainedClaim === undefined
        ? {}
        : {
            reservedPassId: input.reservedPassId,
            retainedClaim: input.retainedClaim,
          }),
      orgId: input.orgId,
      templateId: input.templateId,
      mode: input.mode,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      connectionGeneration: input.generation,
      credentialKeysetCommitment: input.credentialKeysetCommitment,
      expectedConnectionMode: input.expectedConnectionMode,
      execution: {
        kind: 'connection',
        connectionId: input.connectionId,
        generation: input.generation,
      },
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
