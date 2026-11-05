import type { PassJson, Personalization } from '../../../passkit/types.ts';
import type { PassSource } from '../../../shared/contracts/passes.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { ConflictError, NotFoundError, PreconditionFailedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { withoutPersonalizationFiles } from '../apple/personalize-files.ts';
import { registrationCount } from '../apple/repo.ts';
import { isPersonalized } from '../apple/repo-personalize.ts';
import { dispatchSafely } from '../delivery/service.ts';
import { recordPassEvents } from '../events/record.ts';
import { buildArtifact } from './builder.ts';
import { notifiesHolder, overBudget, pushBudgetOf } from './change-messages.ts';
import { getPassForWrite } from './pass-access.ts';
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
import { getRemoval } from './repo-remove.ts';
import type { CommitHook } from './repo-write.ts';
import { newScanCode } from './scan-code.ts';
import type { ScopeArg } from './scope.ts';
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
  orgScope?: ScopeArg;
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
  /**
   * Statements that commit in the same batch as the version write (a scan row, a ledger entry).
   * Each guards itself with `EXISTS (SELECT 1 FROM passes WHERE id = ? AND object_key = ?)`, so a
   * lost CAS leaves no write. Runs only when a version is written, never for an unchanged pass.
   */
  commit?: CommitHook;
}

export interface PublishResult {
  pass: Pass;
  changed: boolean;
  /** The update would have notified, but the pass is at its daily limit: it went out silent. */
  silenced?: boolean;
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
    const current = await getPassForWrite(db, options.passId, options.orgScope ?? null);
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
    const removal = current.removedAt !== null ? await getRemoval(db, current.id) : null;
    const buildRequest = {
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
      ...(removal ? { removal: { at: removal.at, message: removal.message } } : {}),
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
    };
    let artifact = await buildArtifact(buildCtx, buildRequest);
    const previousParsed = previousJson ? (JSON.parse(previousJson) as PassJson) : null;
    let passJson = JSON.stringify(artifact.passJson);
    // A template upgrade that leaves pass.json and every asset unchanged is not a new pass:
    // devices must not be pushed (catalog 22). Legacy rows without a hash compare pass.json.
    const sameContent =
      current.contentHash !== null
        ? current.contentHash === artifact.contentHash
        : next.templateVersion === current.templateVersion && previousJson === passJson;
    const identical = !options.force && next.status === current.status && sameContent;
    if (identical) {
      // Input changes that render the same pass are stored without a version or a push.
      const metaChanged =
        !sameJson(next.personalization, current.personalization) ||
        !sameJson(next.fieldSources, current.fieldSources) ||
        next.externalId !== current.externalId ||
        next.templateVersion !== current.templateVersion ||
        current.contentHash === null ||
        current.scanCode === null;
      if (!metaChanged) return { pass: current, changed: false };
      const written = await casMeta(db, current.id, current.version, {
        personalization: next.personalization,
        fieldSources: next.fieldSources,
        externalId: next.externalId,
        templateVersion: next.templateVersion,
        contentHash: artifact.contentHash,
        barcodeHash: artifact.barcodeHash,
        lookupHash: artifact.lookupHash,
        scanCode,
        objectKey: current.objectKey,
        commit: options.commit,
      });
      if (written === null) {
        if (options.expectedVersion !== undefined) throw new PreconditionFailedError();
        continue;
      }
      return { pass: (await getPass(db, current.id)) ?? current, changed: false };
    }

    // Push budget: a publish that would notify past the daily limit is rebuilt without messages.
    // A removal is exempt: its message is the holder's only notice, and the silent rebuild would
    // still carry it (it is applied after the strip), so the result would claim silence wrongly.
    let silenced = false;
    if (
      !removal &&
      notifiesHolder(artifact.passJson, previousParsed) &&
      overBudget(await pushBudgetOf(ctx, current.id))
    ) {
      artifact = await buildArtifact(buildCtx, { ...buildRequest, silent: true });
      passJson = JSON.stringify(artifact.passJson);
      silenced = true;
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
        lookupHash: artifact.lookupHash,
        scanCode,
        commit: options.commit,
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
    const pushes = options.cause !== 'resign';
    const base = { orgId: pass.orgId, passId: pass.id, mode: pass.mode };
    await recordPassEvents(ctx, [
      {
        ...base,
        kind: 'pass.updated',
        actor: options.actor,
        data: {
          version: pass.version,
          cause: options.cause,
          source: options.source ?? null,
          // Only a resign skips the push; a push carries a message when a field with one changed.
          notified: pushes && notifiesHolder(artifact.passJson, previousParsed),
          ...(silenced ? { overBudget: true } : {}),
        },
      },
      ...(pushes
        ? [
            {
              ...base,
              kind: 'push.queued' as const,
              data: { version: pass.version, devices: await registrationCount(db, pass.id) },
            },
          ]
        : []),
    ]);
    if (options.dispatch !== false) ctx.waitUntil(dispatchSafely(ctx, { passId: pass.id }));
    return { pass, changed: true, ...(silenced ? { silenced } : {}) };
  }
  throw new ConflictError('The pass changed while publishing. Retry.', 'PASS_CONFLICT');
}
