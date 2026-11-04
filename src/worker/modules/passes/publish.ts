import type { PassJson, Personalization } from '../../../passkit/types.ts';
import type { PassSource } from '../../../shared/contracts/passes.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { ConflictError, NotFoundError, PreconditionFailedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { withoutPersonalizationFiles } from '../apple/personalize-files.ts';
import { isPersonalized } from '../apple/repo-personalize.ts';
import { dispatchSafely } from '../delivery/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { buildArtifact } from './builder.ts';
import { notifiesHolder } from './change-messages.ts';
import {
  casMeta,
  casPublish,
  currentPassJson,
  type FieldSources,
  getOrg,
  getPass,
  type Pass,
  type PassCause,
  type PassStatus,
} from './repo.ts';
import { newScanCode } from './scan-code.ts';
import type { Actor } from './service.ts';

export const MAX_CAS_ATTEMPTS = 3;

export interface Mutation {
  personalization?: Personalization;
  fieldSources?: FieldSources;
  templateVersion?: string;
  status?: PassStatus;
  externalId?: string | null;
}

export interface PublishOptions {
  passId: string;
  orgScope?: string | null;
  cause: PassCause;
  /** Why beside the cause: scan, broadcast, schedule, remove, restore or designer. */
  source?: PassSource;
  actor: Actor;
  /** If-Match: a stale version fails with 412 instead of re-reading. */
  expectedVersion?: number;
  /** Publish even when the built pass is identical (re-sign). */
  force?: boolean;
  /** Set false to dispatch pushes later in one go (bulk jobs). Default true. */
  dispatch?: boolean;
  /** Derives the desired state from the freshly read row; re-run on every retry. */
  mutate?: (current: Pass) => Mutation;
  /**
   * An editor's save: true messages holders about the fields it changes, false strips every
   * changeMessage. Omit for syncs and upgrades (the template's messages stay).
   */
  notify?: boolean;
}

export interface PublishResult {
  pass: Pass;
  changed: boolean;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * build -> R2 put -> D1 compare-and-swap, re-reading up to three times when another writer wins.
 * A lost race is never an error code on the pass; it only surfaces as 409 after the last attempt.
 */
export async function publishPass(
  ctx: ServiceContext,
  options: PublishOptions,
): Promise<PublishResult> {
  const db = ctx.env.DB;
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const current = await getPass(db, options.passId, options.orgScope ?? null);
    if (!current) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    if (options.expectedVersion !== undefined && current.version !== options.expectedVersion)
      throw new PreconditionFailedError();
    const mutation = options.mutate?.(current) ?? {};
    const next = {
      personalization: mutation.personalization ?? current.personalization,
      fieldSources: mutation.fieldSources ?? current.fieldSources,
      templateVersion: mutation.templateVersion ?? current.templateVersion,
      status: mutation.status ?? current.status,
      externalId: mutation.externalId === undefined ? current.externalId : mutation.externalId,
    };
    const org = await getOrg(db, current.orgId);
    if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
    // Once Wallet has personalized the pass, personalization.json must stay out of every build.
    const buildCtx = (await isPersonalized(db, current.id))
      ? withoutPersonalizationFiles(ctx)
      : ctx;
    const previousJson = await currentPassJson(db, current.id);
    const previous = options.notify === undefined ? null : previousJson;
    // Older passes get their scan code on the first publish after it was introduced.
    const scanCode = current.scanCode ?? newScanCode(ctx);
    const artifact = await buildArtifact(buildCtx, {
      orgId: current.orgId,
      orgName: org.name,
      branding: org.branding,
      ...(options.notify === undefined
        ? {}
        : {
            changeMessages: {
              previous: previous ? (JSON.parse(previous) as PassJson) : null,
              notify: options.notify,
            },
          }),
      passId: current.id,
      scanCode,
      serial: current.serial,
      authToken: current.authToken,
      webServiceUrl: current.webServiceUrl,
      identityId: current.identityId,
      templateId: current.templateId,
      templateVersion: next.templateVersion,
      personalization: next.personalization,
      status: next.status,
    });
    const passJson = JSON.stringify(artifact.passJson);
    // A template upgrade that leaves pass.json and every asset unchanged is not a new pass:
    // devices must not be pushed (catalog 22). Legacy rows without a hash compare pass.json.
    const sameContent =
      current.contentHash !== null
        ? current.contentHash === artifact.contentHash
        : next.templateVersion === current.templateVersion && previousJson === passJson;
    const identical =
      !options.force &&
      next.status === current.status &&
      sameJson(next.personalization, current.personalization) &&
      sameContent;
    if (identical) {
      const metaChanged =
        !sameJson(next.fieldSources, current.fieldSources) ||
        next.externalId !== current.externalId ||
        next.templateVersion !== current.templateVersion ||
        current.contentHash === null ||
        current.scanCode === null;
      if (!metaChanged) return { pass: current, changed: false };
      const written = await casMeta(db, current.id, current.version, {
        fieldSources: next.fieldSources,
        externalId: next.externalId,
        templateVersion: next.templateVersion,
        contentHash: artifact.contentHash,
        barcodeHash: artifact.barcodeHash,
        scanCode,
      });
      if (written === null) {
        if (options.expectedVersion !== undefined) throw new PreconditionFailedError();
        continue;
      }
      return { pass: (await getPass(db, current.id)) ?? current, changed: false };
    }

    const now = ctx.clock.now();
    const objectKey = `passes/${current.id}/v${current.version + 1}-${ctx.ids.token(6)}.pkpass`;
    await ctx.env.BUCKET.put(objectKey, artifact.bytes, {
      httpMetadata: { contentType: 'application/vnd.apple.pkpass' },
    });
    let written: number | null;
    try {
      written = await casPublish(db, {
        id: current.id,
        expectedVersion: current.version,
        previousModifiedAt: current.modifiedAt,
        now,
        templateVersion: next.templateVersion,
        personalization: next.personalization,
        fieldSources: next.fieldSources,
        displayTitle: artifact.title,
        displaySubtitle: artifact.subtitle,
        externalId: next.externalId,
        status: next.status,
        objectKey,
        objectSha256: artifact.sha256,
        objectSize: artifact.bytes.length,
        contentHash: artifact.contentHash,
        cause: options.cause,
        source: options.source ?? null,
        actorType: options.actor.type,
        actorId: options.actor.id,
        passJson,
        barcodeHash: artifact.barcodeHash,
        scanCode,
      });
    } catch (error) {
      // Ambiguous D1 failure: the commit may have succeeded, so the object stays.
      ctx.log.error('pass.publish_failed', { passId: current.id, code: 'PUBLISH_D1', error });
      throw error;
    }
    if (written === null) {
      await ctx.env.BUCKET.delete(objectKey);
      if (options.expectedVersion !== undefined) throw new PreconditionFailedError();
      ctx.log.info('pass.publish_conflict', { passId: current.id, attempt });
      continue;
    }
    const pass = await getPass(db, current.id);
    if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    writeEvent(ctx.env, {
      event: 'pass.updated',
      orgId: pass.orgId,
      templateId: pass.templateId,
      identityId: pass.identityId,
      outcome: options.cause,
      mode: pass.mode,
    });
    // Seam: later streams add their own events (push, device, scan) at their own call sites.
    await recordPassEvent(ctx, {
      orgId: pass.orgId,
      passId: pass.id,
      mode: pass.mode,
      kind: 'pass.updated',
      actor: options.actor,
      data: {
        version: pass.version,
        cause: options.cause,
        source: options.source ?? null,
        // Only a resign skips the push; a push carries a message when a field with one changed.
        notified:
          options.cause !== 'resign' &&
          notifiesHolder(
            artifact.passJson,
            previousJson ? (JSON.parse(previousJson) as PassJson) : null,
          ),
      },
    });
    if (options.dispatch !== false) ctx.waitUntil(dispatchSafely(ctx, { passId: pass.id }));
    return { pass, changed: true };
  }
  throw new ConflictError('The pass changed while publishing. Retry.', 'PASS_CONFLICT');
}
