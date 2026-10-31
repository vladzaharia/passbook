import type { Personalization } from '../../../passkit/types.ts';
import { strictEmail } from '../../../shared/email.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { baseUrl } from '../../platform/env.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { runAttachHookA } from '../holders/service.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { PLATFORM_IDENTITY_ID } from '../identities/resolver.ts';
import { buildArtifact, resolveTemplate } from './builder.ts';
import { depsOf } from './deps.ts';
import { detailOf } from './detail.ts';
import {
  claimIdempotencyKey,
  connectionInOrg,
  finishIdempotencyKey,
  getIdempotencyKey,
  getOrg,
  getPass,
  insertPass,
  type Pass,
} from './repo.ts';
import type { Actor } from './service.ts';

export interface CreateParams {
  orgId: string;
  templateId: string;
  templateVersion?: string;
  identityId?: string;
  input: Personalization;
  holderEmail?: string | null;
  externalId?: string | null;
  serial?: string;
  connectionId?: string | null;
  externalRef?: string | null;
  sendEmail?: boolean;
  source: 'manual' | 'connection';
  actor: Actor;
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

/** Builds, stores and inserts a pass; the `pass_created` trigger records version 1. */
export async function createPassRow(ctx: ServiceContext, p: CreateParams): Promise<Pass> {
  const db = ctx.env.DB;
  const org = await getOrg(db, p.orgId);
  if (!org || org.status !== 'active')
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const holderEmail = p.holderEmail ? strictEmail(p.holderEmail) : null;
  if (p.holderEmail && !holderEmail)
    throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (p.connectionId && !(await connectionInOrg(db, p.connectionId, p.orgId)))
    throw new ValidationError(
      'The connection does not belong to this organization.',
      [],
      'CONNECTION_ORG',
    );

  const template = await resolveTemplate(ctx, p.orgId, p.templateId, p.templateVersion);
  const identity = await depsOf(ctx.env).identities.forOrg(p.orgId, p.identityId);
  if (identity.id === PLATFORM_IDENTITY_ID) await ensurePlatformIdentity(ctx.env, ctx.clock.now());

  const id = ctx.ids.id();
  const serial = p.serial ?? ctx.ids.id();
  const authToken = ctx.ids.token();
  const webServiceUrl = `${baseUrl(ctx.env)}/wallet`;
  const artifact = await buildArtifact(ctx, {
    orgId: p.orgId,
    orgName: org.name,
    passId: id,
    serial,
    authToken,
    webServiceUrl,
    identityId: identity.id,
    templateId: template.id,
    templateVersion: template.version,
    personalization: p.input,
    status: 'active',
  });
  const objectKey = `passes/${id}/v1-${ctx.ids.token(6)}.pkpass`;
  await ctx.env.BUCKET.put(objectKey, artifact.bytes, {
    httpMetadata: { contentType: 'application/vnd.apple.pkpass' },
  });
  try {
    await insertPass(db, {
      id,
      orgId: p.orgId,
      identityId: identity.id,
      serial,
      templateId: template.id,
      templateVersion: template.version,
      authToken,
      downloadToken: ctx.ids.token(),
      webServiceUrl,
      personalization: p.input,
      fieldSources: Object.fromEntries(Object.keys(p.input).map((k) => [k, p.source])),
      displayTitle: artifact.title,
      displaySubtitle: artifact.subtitle,
      externalId: p.externalId ?? null,
      holderEmail,
      connectionId: p.connectionId ?? null,
      externalRef: p.externalRef ?? null,
      objectKey,
      objectSha256: artifact.sha256,
      objectSize: artifact.bytes.length,
      now: ctx.clock.now(),
      createdBy: p.actor.type === 'user' ? p.actor.id : null,
      passJson: JSON.stringify(artifact.passJson),
      actorType: p.actor.type,
      actorId: p.actor.id,
    });
  } catch (error) {
    await ctx.env.BUCKET.delete(objectKey);
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: passes\.(identity_id|download_token)/.test(error.message)
    )
      throw new ConflictError('That serial is already in use.', 'SERIAL_TAKEN');
    throw error;
  }
  const pass = await getPass(db, id);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (holderEmail) await runAttachHookA(ctx, id, p.actor);
  await recordAudit(ctx, {
    orgId: p.orgId,
    actorType: p.actor.type,
    actorId: p.actor.id,
    action: 'pass.create',
    targetType: 'pass',
    targetId: id,
    detail: { templateId: template.id, connectionId: p.connectionId ?? null },
  });
  writeEvent(ctx.env, {
    event: 'pass.issued',
    orgId: p.orgId,
    templateId: template.id,
    identityId: identity.id,
  });
  if (p.sendEmail && holderEmail)
    await enqueuePassEmail(ctx, { passId: id, to: holderEmail, attach: false });
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
  const claimed = await claimIdempotencyKey(db, p.orgId, key, hash, ctx.clock.now());
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
    const pass = await createPassRow(ctx, p);
    await finishIdempotencyKey(db, p.orgId, key, pass.id);
    return detailOf(ctx, pass);
  } catch (error) {
    await finishIdempotencyKey(db, p.orgId, key, null);
    throw error;
  }
}
