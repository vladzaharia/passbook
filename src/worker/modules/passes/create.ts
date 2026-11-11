import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { baseUrl } from '../../platform/env.ts';
import {
  AppError,
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { runAttachHookA } from '../holders/service.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { PLATFORM_IDENTITY_ID } from '../identities/resolver.ts';
import { buildArtifact, resolveTemplate } from './builder.ts';
import { depsOf } from './deps.ts';
import { detailOf } from './detail.ts';
import {
  claimIdempotencyKey,
  connectionForPass,
  connectionInOrg,
  finishIdempotencyKey,
  getCreateTemplate,
  getIdempotencyKey,
  getOrg,
  getPass,
  insertPass,
  type Pass,
} from './repo.ts';
import { newScanCode } from './scan-code.ts';
import type { Actor } from './service.ts';

export interface CreateParams {
  orgId: string;
  templateId: string;
  templateVersion: string;
  identityId?: string;
  input: Personalization;
  holderEmail?: string | null;
  externalId?: string | null;
  serial?: string;
  connectionId?: string | null;
  externalRef?: string | null;
  sendEmail?: boolean;
  source: 'manual' | 'connection';
  /** The mode explicitly reviewed by the caller (connection syncs are Live-only). */
  mode: Mode;
  /** Generation captured before a connection run fetched its source data. */
  connectionGeneration?: number;
  actor: Actor;
  /** Preassigned pass id; idempotent creates reserve it with the key. */
  passId?: string;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function assertCreateAuthority(
  ctx: ServiceContext,
  p: CreateParams,
  generation: number | null,
): Promise<void> {
  const db = ctx.env.DB;
  const org = await getOrg(db, p.orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const template = await getCreateTemplate(db, p.templateId);
  if (
    !template ||
    template.status !== 'active' ||
    (template.orgId !== null && template.orgId !== p.orgId)
  )
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  if (template.activeVersion !== p.templateVersion) throw new PreconditionFailedError();
  if (p.connectionId) {
    const connection = await connectionForPass(db, p.connectionId, p.orgId, p.mode);
    if (!connection || connection.generation !== generation)
      throw new ConflictError('The connection changed. Reload and retry.', 'PASS_CONFLICT');
  }
}

/** Builds, stores and inserts a pass; the `pass_created` trigger records version 1. */
export async function createPassRow(ctx: ServiceContext, p: CreateParams): Promise<Pass> {
  const db = ctx.env.DB;
  if ((p.mode !== 'live' && p.mode !== 'test') || !p.templateVersion)
    throw new ValidationError('Review the mode and template version before issuing the pass.');
  if (p.source === 'connection' && (!p.connectionId || p.connectionGeneration === undefined))
    throw new ConflictError('The connection run is missing its original context.', 'PASS_CONFLICT');
  const org = await getOrg(db, p.orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const holderEmail = p.holderEmail ? strictEmail(p.holderEmail) : null;
  if (p.holderEmail && !holderEmail)
    throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (p.connectionId && p.mode !== 'live')
    throw new ConflictError('Test passes cannot use a Live connection.', 'MODE_MISMATCH');
  if (p.connectionId && !(await connectionInOrg(db, p.connectionId, p.orgId)))
    throw new ValidationError(
      'The connection does not belong to this organization.',
      [],
      'CONNECTION_ORG',
    );
  if (p.source === 'connection' && p.mode !== 'live')
    throw new ConflictError('Connection syncs require Live mode.', 'MODE_MISMATCH');
  let connectionGeneration: number | null = null;
  if (p.connectionId) {
    const connection = await connectionForPass(db, p.connectionId, p.orgId, p.mode);
    if (!connection || (p.source === 'connection' && connection.generation !== p.connectionGeneration))
      throw new ConflictError('The connection changed. Reload and retry.', 'PASS_CONFLICT');
    connectionGeneration = connection.generation;
  }

  const template = await resolveTemplate(ctx, p.orgId, p.templateId, p.templateVersion);
  if (template.version !== p.templateVersion) throw new PreconditionFailedError();
  await assertCreateAuthority(ctx, p, connectionGeneration);
  const identity = await depsOf(ctx.env).identities.forOrg(p.orgId, p.identityId);
  if (identity.id === PLATFORM_IDENTITY_ID) await ensurePlatformIdentity(ctx.env, ctx.clock.now());

  const id = p.passId ?? ctx.ids.id();
  const mode = p.mode;
  const scanCode = newScanCode(ctx);
  const serial = p.serial ?? ctx.ids.id();
  const authToken = ctx.ids.token();
  const downloadToken = ctx.ids.token();
  const webServiceUrl = `${baseUrl(ctx.env)}/wallet`;
  const artifact = await buildArtifact(ctx, {
    orgId: p.orgId,
    orgName: org.name,
    branding: org.branding,
    passId: id,
    scanCode,
    serial,
    authToken,
    webServiceUrl,
    identityId: identity.id,
    templateId: template.id,
    templateVersion: template.version,
    personalization: p.input,
    status: 'active',
  });
  // Building may await external assets or signing. Recheck authoritative state before storing.
  await assertCreateAuthority(ctx, p, connectionGeneration);
  const objectKey = `passes/${id}/v1-${ctx.ids.token(6)}.pkpass`;
  await ctx.env.BUCKET.put(objectKey, artifact.bytes, {
    httpMetadata: { contentType: 'application/vnd.apple.pkpass' },
  });
  try {
    const inserted = await insertPass(db, {
      id,
      orgId: p.orgId,
      identityId: identity.id,
      serial,
      templateId: template.id,
      templateVersion: template.version,
      authToken,
      downloadToken,
      webServiceUrl,
      personalization: p.input,
      // A bound pass takes its fields from the connection until an admin edits them.
      fieldSources: Object.fromEntries(
        Object.keys(p.input).map((k) => [k, p.connectionId ? 'connection' : p.source]),
      ),
      displayTitle: artifact.title,
      displaySubtitle: artifact.subtitle,
      externalId: p.externalId ?? null,
      holderEmail,
      connectionId: p.connectionId ?? null,
      connectionGeneration,
      externalRef: p.externalRef ?? null,
      objectKey,
      objectSha256: artifact.sha256,
      objectSize: artifact.bytes.length,
      contentHash: artifact.contentHash,
      now: ctx.clock.now(),
      createdBy: p.actor.type === 'user' ? p.actor.id : null,
      passJson: JSON.stringify(artifact.passJson),
      actorType: p.actor.type,
      actorId: p.actor.id,
      mode,
      scanCode,
      barcodeHash: artifact.barcodeHash,
      lookupHash: artifact.lookupHash,
    });
    if (!inserted) throw new PreconditionFailedError();
  } catch (error) {
    await ctx.env.BUCKET.delete(objectKey);
    const info = classifyD1Error(error);
    if (info?.kind === 'unique' && /passes\.(identity_id|download_token)/.test(info.detail))
      throw new ConflictError('That serial is already in use.', 'SERIAL_TAKEN');
    if (info?.kind === 'unique' && /passes\.external_ref/.test(info.detail))
      throw new ConflictError('That connection ref already has a pass.', 'PASS_REF_TAKEN');
    throw error;
  }
  const pass = await getPass(db, id);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (
    holderEmail &&
    (pass.orgId !== p.orgId ||
      pass.mode !== mode ||
      pass.status !== 'active' ||
      pass.removedAt !== null ||
      pass.version !== 1 ||
      pass.linkGeneration !== 1 ||
      pass.ownerUserId !== null ||
      pass.templateId !== template.id ||
      pass.templateVersion !== template.version ||
      pass.serial !== serial ||
      pass.authToken !== authToken ||
      pass.downloadToken !== downloadToken ||
      pass.objectKey !== objectKey ||
      pass.holderEmail !== holderEmail)
  )
    throw new ConflictError('The pass changed before delivery.', 'PASS_CONFLICT');
  const attached = holderEmail ? await runAttachHookA(ctx, id, p.actor) : false;
  await recordAudit(ctx, {
    orgId: p.orgId,
    actorType: p.actor.type,
    actorId: p.actor.id,
    action: 'pass.create',
    targetType: 'pass',
    targetId: id,
    detail: { templateId: template.id, connectionId: p.connectionId ?? null },
  });
  await recordPassEvent(ctx, {
    orgId: p.orgId,
    passId: id,
    mode,
    kind: 'pass.issued',
    actor: p.actor,
    data: { version: 1, cause: 'create', source: null, notified: false },
  });
  writeEvent(ctx.env, {
    event: 'pass.issued',
    orgId: p.orgId,
    templateId: template.id,
    identityId: identity.id,
    mode,
  });
  if (p.sendEmail && holderEmail) {
    try {
      const recipientPass = await getPass(db, id);
      if (
        !recipientPass ||
        recipientPass.orgId !== pass.orgId ||
        recipientPass.mode !== pass.mode ||
        recipientPass.status !== 'active' ||
        recipientPass.removedAt !== null ||
        recipientPass.version !== pass.version ||
        recipientPass.linkGeneration !== pass.linkGeneration + (attached ? 1 : 0) ||
        (attached ? recipientPass.ownerUserId === null : recipientPass.ownerUserId !== pass.ownerUserId) ||
        recipientPass.templateId !== pass.templateId ||
        recipientPass.templateVersion !== pass.templateVersion ||
        recipientPass.serial !== pass.serial ||
        recipientPass.authToken !== pass.authToken ||
        recipientPass.downloadToken !== pass.downloadToken ||
        recipientPass.objectKey !== pass.objectKey ||
        recipientPass.holderEmail !== holderEmail
      )
        throw new ConflictError('The pass changed before delivery.', 'PASS_CONFLICT');
      await enqueuePassEmail(ctx, {
        passId: id,
        to: holderEmail,
        attach: false,
        expected: recipientPass,
      });
    } catch (error) {
      // The pass exists; a capped email is resent on request, not a failed create.
      if (!(error instanceof AppError) || error.code !== 'EMAIL_RATE_LIMITED') throw error;
      ctx.log.warn('passes.email_rate_limited', {
        code: 'EMAIL_RATE_LIMITED',
        orgId: p.orgId,
        passId: id,
      });
    }
  }
  return (await getPass(db, id)) ?? pass;
}

/**
 * Admin/API create. With an Idempotency-Key a retry returns the original pass; the same key with a
 * different body is rejected.
 */
export async function createPassIdempotent(
  ctx: ServiceContext,
  p: CreateParams,
  key: string | undefined,
) {
  if (!key) return detailOf(ctx, await createPassRow(ctx, p));
  const db = ctx.env.DB;
  const hash = await sha256Hex(stableStringify({ ...p, actor: undefined }));
  const passId = ctx.ids.id();
  const claimed = await claimIdempotencyKey(db, p.orgId, key, hash, passId, ctx.clock.now());
  if (!claimed) {
    const existing = await getIdempotencyKey(db, p.orgId, key);
    if (!existing || existing.requestHash !== hash)
      throw new ConflictError(
        'The Idempotency-Key was used with a different request.',
        'IDEMPOTENCY_KEY_REUSED',
      );
    const pass = existing.resourceId ? await getPass(db, existing.resourceId, p.orgId) : null;
    if (!pass)
      throw new ConflictError(
        'The original request is still running. Retry shortly.',
        'IDEMPOTENCY_IN_PROGRESS',
      );
    return detailOf(ctx, pass);
  }
  try {
    return detailOf(ctx, await createPassRow(ctx, { ...p, passId }));
  } catch (error) {
    // Once the row is committed the key keeps pointing at it, so a retry replays that pass.
    if (!(await getPass(db, passId))) await finishIdempotencyKey(db, p.orgId, key, null);
    throw error;
  }
}
