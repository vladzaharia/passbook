import type { Personalization } from '../../../passkit/types.ts';
import type { PassSource } from '../../../shared/contracts/passes.ts';
import { coalesceTo, type SetValue } from '../../platform/authority-expr.ts';
import type { HolderPrincipal } from '../../platform/authority-principal.ts';
import type { Clock } from '../../platform/clock.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import type { ConnectionPassContext } from './repo-connection-context.ts';
import type { FieldSources, PassCause, PassStatus } from './repo-map.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';
import { permitsPassMutation } from './repo-write-authority.ts';
import { casConnector } from './repo-write-publish-connector.ts';
import { casGranted } from './repo-write-publish-granted.ts';
import { type PublishPassSnapshot, permitsPublishRelease } from './repo-write-publish-snapshot.ts';

export interface PublishWrite {
  id: string;
  expectedVersion: number;
  previousModifiedAt: number;
  now: number;
  templateVersion: string;
  /** The approved target release; required when the template version changes. */
  release?: PassReleaseSnapshot | undefined;
  /** For a legacy same-version pass, fence the absence of scoped release history. */
  requireNoReleaseHistory?: boolean | undefined;
  personalization: Personalization;
  fieldSources: FieldSources;
  displayTitle: string | null;
  displaySubtitle: string | null;
  externalId: string | null;
  status: PassStatus;
  objectKey: string;
  objectSha256: string;
  objectSize: number;
  contentHash: string;
  cause: PassCause;
  /** Why beside the cause (scan, broadcast, ...); copied to pass_versions.source by the trigger. */
  source: PassSource | null;
  actorType: string | null;
  actorId: string | null;
  passJson: string;
  barcodeHash: string | null;
  lookupHash: string | null;
  /** Written only while the pass has none (lazy backfill). */
  scanCode: string;
  /** Owner/credentials and lifecycle observed when this publish began. */
  expectedPass: PublishPassSnapshot;
  /** Set only for an explicitly staged removal represented by this artifact. */
  publishedRemovalGeneration?: number | undefined;
  connectionContext?: ConnectionPassContext | undefined;
  connectionState?: ConnectionStateWrite | undefined;
  authority?: TenantPassWrite | undefined;
  holder?: HolderPrincipal | undefined;
  /** Required with authority, so its expiry is checked immediately before the batch. */
  clock?: Clock | undefined;
}

export interface ConnectionStateWrite {
  syncErrorCode: string | null;
}

/**
 * Compare-and-swap publish. RETURNING (not meta.changes) identifies the winner because D1 counts
 * trigger writes. Returns the new version, or null when another writer got there first.
 */
export async function casPublish(ctx: ServiceContext, w: PublishWrite): Promise<number | null> {
  if (!permitsPassMutation(w.authority)) return null;
  const release = w.release;
  const changesTemplateVersion = w.templateVersion !== w.expectedPass.templateVersion;
  if (
    !permitsPublishRelease(
      w.expectedPass,
      w.templateVersion,
      release,
      w.requireNoReleaseHistory ?? false,
    )
  )
    return null;
  if (
    w.publishedRemovalGeneration !== undefined &&
    (w.source !== 'remove' ||
      w.status !== 'voided' ||
      w.expectedPass.removedAt === null ||
      w.publishedRemovalGeneration !== w.expectedPass.lifecycleGeneration)
  )
    return null;
  if (w.authority && !w.clock) throw new Error('A clock is required for tenant authority.');
  const sameSecond = Math.floor(w.now / 1000) === Math.floor(w.previousModifiedAt / 1000);
  const personalization = JSON.stringify(w.personalization);
  const fieldSources = JSON.stringify(w.fieldSources);
  // A tenant publish is one grant. Connector and legacy-without-history writes have no tenant principal
  // (or need the absence of a head), so they keep the compare-and-swap statement below.
  {
    const set: Record<string, SetValue> = {
      template_version: w.templateVersion,
      ...(changesTemplateVersion && release ? { release_id: release.id } : {}),
      personalization,
      field_sources: fieldSources,
      display_title: w.displayTitle,
      display_subtitle: w.displaySubtitle,
      external_id: w.externalId,
      status: w.status,
      object_key: w.objectKey,
      object_sha256: w.objectSha256,
      object_size: w.objectSize,
      content_hash: w.contentHash,
      modified_at: w.now,
      modified_collision: sameSecond ? 1 : 0,
      sync_error_code: w.connectionState?.syncErrorCode ?? null,
      pending_cause: w.cause,
      pending_actor_type: w.actorType,
      pending_actor_id: w.actorId,
      pending_pass_json: w.passJson,
      pending_source: w.source,
      barcode_hash: w.barcodeHash,
      lookup_hash: w.lookupHash,
      scan_code: coalesceTo(w.scanCode),
      removal_published_generation:
        w.publishedRemovalGeneration ??
        (w.expectedPass.removedAt !== null &&
        w.expectedPass.removalPublishedGeneration === w.expectedPass.lifecycleGeneration
          ? w.expectedPass.lifecycleGeneration
          : null),
    };
    const common = {
      id: w.id,
      expectedVersion: w.expectedVersion,
      expectedPass: w.expectedPass,
      release,
      requireNoReleaseHistory: w.requireNoReleaseHistory ?? false,
      set,
      removalClaim: w.publishedRemovalGeneration !== undefined,
    };
    // A tenant publish is one grant. A connector (or legacy no-principal) publish is a connection job grant.
    return w.authority && !w.connectionContext
      ? casGranted(ctx, { ...common, authority: w.authority })
      : casConnector(ctx, {
          ...common,
          bumpVersion: true,
          context: w.connectionContext,
          authority: w.authority,
          holder: w.holder,
        });
  }
}

/** Metadata-only change (no new object, no push). Still bumps the version. */
export async function casMeta(
  ctx: ServiceContext,
  id: string,
  expectedVersion: number,
  set: {
    personalization: Personalization;
    fieldSources: FieldSources;
    externalId: string | null;
    templateVersion: string;
    /** The approved target release; required when the template version changes. */
    release?: PassReleaseSnapshot | undefined;
    /** For a legacy same-version pass, fence the absence of scoped release history. */
    requireNoReleaseHistory?: boolean | undefined;
    contentHash: string;
    barcodeHash: string | null;
    lookupHash: string | null;
    scanCode: string;
    /** The object key the pass keeps (a metadata write adds no object). */
    objectKey: string;
    expectedPass: PublishPassSnapshot;
    connectionContext?: ConnectionPassContext | undefined;
    connectionState?: ConnectionStateWrite | undefined;
    authority?: TenantPassWrite | undefined;
    holder?: HolderPrincipal | undefined;
    /** Required with authority, so its expiry is checked immediately before the batch. */
    clock?: Clock | undefined;
  },
): Promise<number | null> {
  if (!permitsPassMutation(set.authority)) return null;
  const release = set.release;
  const changesTemplateVersion = set.templateVersion !== set.expectedPass.templateVersion;
  if (
    !permitsPublishRelease(
      set.expectedPass,
      set.templateVersion,
      release,
      set.requireNoReleaseHistory ?? false,
    )
  )
    return null;
  if (set.authority && !set.clock) throw new Error('A clock is required for tenant authority.');
  const personalization = JSON.stringify(set.personalization);
  const fieldSources = JSON.stringify(set.fieldSources);
  const common = {
    id,
    expectedVersion,
    expectedPass: set.expectedPass,
    release,
    requireNoReleaseHistory: set.requireNoReleaseHistory ?? false,
    set: {
      personalization,
      field_sources: fieldSources,
      external_id: set.externalId,
      template_version: set.templateVersion,
      ...(changesTemplateVersion && release ? { release_id: release.id } : {}),
      content_hash: set.contentHash,
      barcode_hash: set.barcodeHash,
      lookup_hash: set.lookupHash,
      scan_code: coalesceTo(set.scanCode),
      ...(set.connectionState ? { sync_error_code: set.connectionState.syncErrorCode } : {}),
    },
  };
  return set.authority && !set.connectionContext
    ? casGranted(ctx, { ...common, authority: set.authority })
    : casConnector(ctx, {
        ...common,
        bumpVersion: true,
        context: set.connectionContext,
        authority: set.authority,
        holder: set.holder,
      });
}
