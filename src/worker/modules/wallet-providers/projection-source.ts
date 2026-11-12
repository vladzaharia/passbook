import type { AssetEntry } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  candidateHash,
  ReleaseContentError,
  templateContentHash,
} from '../templates/release-content.ts';
import { getVersion, type VersionRow } from '../templates/repo.ts';
import { listVersionExtras } from '../templates/repo-preview-extras.ts';
import { getCandidate, getRelease, type ReleaseRow } from '../templates/repo-releases.ts';
import type { NativeProjection } from './projection-contract.ts';
import { effectiveAppleSourceId } from './repo-projection.ts';

const unsupported = () =>
  new ConflictError(
    'This template contains wallet semantics that are not supported by the selected native projection.',
    'WALLET_PROJECTION_UNSUPPORTED',
  );
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export interface ProjectionSourceDocument {
  manifest: unknown;
  passJson: unknown;
  assets: readonly AssetEntry[];
}

/** Every renderable source semantic must be represented; unknown extensions fail closed. */
export function assertProjectionSource(
  projection: NativeProjection,
  version: ProjectionSourceDocument,
): void {
  const manifest: unknown = version.manifest;
  const pass: unknown = version.passJson;
  if (!object(manifest) || !object(pass) || !Array.isArray(version.assets)) throw unsupported();
  if (
    !only(manifest, [
      'schema',
      'name',
      'description',
      'inputs',
      'sample',
      'lookups',
      'bindings',
      'display',
      'requires',
      'org',
      'previewOnlyAssets',
      'scan',
      'nfc',
    ])
  )
    throw unsupported();
  if (manifest.schema !== 1 || !Array.isArray(manifest.bindings)) throw unsupported();
  if (
    manifest.nfc !== undefined &&
    (!object(manifest.nfc) || !only(manifest.nfc, ['enabled']) || manifest.nfc.enabled !== false)
  )
    throw unsupported();
  if (
    manifest.requires !== undefined &&
    (!object(manifest.requires) ||
      !only(manifest.requires, ['styles', 'nfc']) ||
      (manifest.requires.nfc !== undefined && manifest.requires.nfc !== false) ||
      (manifest.requires.styles !== undefined &&
        (!Array.isArray(manifest.requires.styles) ||
          manifest.requires.styles.some((style) => style !== 'generic'))))
  )
    throw unsupported();
  if (
    !only(pass, [
      'formatVersion',
      'passTypeIdentifier',
      'teamIdentifier',
      'serialNumber',
      'organizationName',
      'description',
      'generic',
      'barcode',
      'barcodes',
    ]) ||
    pass.formatVersion !== 1 ||
    typeof pass.organizationName !== 'string' ||
    !pass.organizationName ||
    typeof pass.description !== 'string' ||
    !pass.description ||
    !object(pass.generic) ||
    !only(pass.generic, [
      'headerFields',
      'primaryFields',
      'secondaryFields',
      'auxiliaryFields',
      'backFields',
    ])
  )
    throw unsupported();

  const keys = new Set<string>();
  for (const group of Object.values(pass.generic)) {
    if (!Array.isArray(group)) throw unsupported();
    for (const field of group) {
      if (
        !object(field) ||
        !only(field, ['key', 'value', 'label', '_id']) ||
        typeof field.key !== 'string' ||
        !field.key ||
        keys.has(field.key) ||
        (typeof field.value !== 'string' && typeof field.value !== 'number') ||
        (field.label !== undefined && typeof field.label !== 'string')
      )
        throw unsupported();
      keys.add(field.key);
    }
  }
  if (
    keys.size !== projection.fields.length ||
    projection.fields.some((key) => !keys.has(key)) ||
    !keys.has(projection.titleField)
  )
    throw unsupported();

  if (pass.barcode !== undefined && pass.barcodes !== undefined) throw unsupported();
  const barcodes =
    pass.barcodes === undefined
      ? pass.barcode === undefined
        ? []
        : [pass.barcode]
      : pass.barcodes;
  if (
    !Array.isArray(barcodes) ||
    barcodes.length > 1 ||
    (projection.barcode === 'none' ? barcodes.length !== 0 : barcodes.length !== 1)
  )
    throw unsupported();
  for (const barcode of barcodes) {
    if (
      !object(barcode) ||
      !only(barcode, ['format', 'message', 'messageEncoding', 'altText']) ||
      barcode.format !== 'PKBarcodeFormatQR' ||
      typeof barcode.message !== 'string' ||
      typeof barcode.messageEncoding !== 'string' ||
      barcode.messageEncoding.toLowerCase() !== 'utf-8' ||
      (barcode.altText !== undefined &&
        (projection.provider === 'samsung' || typeof barcode.altText !== 'string'))
    )
      throw unsupported();
  }
  for (const binding of manifest.bindings) {
    if (
      !object(binding) ||
      !only(binding, ['to', 'value', 'when', 'remove', 'omitIfEmpty']) ||
      !object(binding.to)
    )
      throw unsupported();
    const to = binding.to;
    if ('field' in to) {
      if (
        !only(to, ['field', 'prop']) ||
        (to.prop !== undefined && to.prop !== 'value' && to.prop !== 'label')
      )
        throw unsupported();
      const fields = Array.isArray(to.field) ? to.field : [to.field];
      if (!fields.length || fields.some((field) => typeof field !== 'string' || !keys.has(field)))
        throw unsupported();
    } else if ('barcode' in to) {
      if (
        !only(to, ['barcode', 'prop']) ||
        (to.barcode !== 0 && to.barcode !== '*') ||
        projection.barcode !== 'qr' ||
        pass.barcode !== undefined ||
        (to.prop !== 'message' && !(projection.provider === 'google' && to.prop === 'altText'))
      )
        throw unsupported();
    } else throw unsupported();
  }
  const preview = manifest.previewOnlyAssets;
  if (
    preview !== undefined &&
    (!Array.isArray(preview) || preview.some((name) => typeof name !== 'string'))
  )
    throw unsupported();
  const previewNames = new Set((preview ?? []) as string[]);
  const slots = new Set<string>();
  for (const asset of version.assets) {
    if (previewNames.has(asset.name)) continue;
    if ((asset.slot !== 'icon' && asset.slot !== 'logo') || asset.locale !== undefined)
      throw unsupported();
    slots.add(asset.slot);
  }
  if (
    slots.size !== projection.sourceArtworkSlots.length ||
    projection.sourceArtworkSlots.some((slot) => !slots.has(slot))
  )
    throw unsupported();
}

export interface AppleSourceScope {
  templateId: string;
  orgId: string;
  mode: Mode;
  sourceReleaseId: string;
  version: string;
}
export interface VerifiedAppleSource {
  release: ReleaseRow;
  version: VersionRow;
}

/** Recompute the full Apple digest and every referenced asset before accepting provenance. */
export async function verifiedAppleSource(
  ctx: ServiceContext,
  scope: AppleSourceScope,
): Promise<VerifiedAppleSource | null> {
  if ((await effectiveAppleSourceId(ctx.env.DB, scope)) !== scope.sourceReleaseId) return null;
  const release = await getRelease(ctx.env.DB, scope.sourceReleaseId);
  if (
    release?.provider !== 'apple' ||
    release.templateId !== scope.templateId ||
    release.mode !== scope.mode ||
    release.version !== scope.version
  )
    return null;
  const version = await getVersion(ctx.env.DB, scope.templateId, scope.version);
  if (!version) return null;
  try {
    const extras = await listVersionExtras(ctx.env.DB, scope.templateId, scope.version);
    if ((await templateContentHash(ctx, version, extras)) !== release.contentHash) return null;
    const candidate =
      release.source === 'approved' && release.candidateId
        ? await getCandidate(ctx.env.DB, release.candidateId)
        : null;
    if (
      release.source === 'approved' &&
      (!candidate || !version.report.ok || candidate.versionAuthorId !== version.createdBy)
    )
      return null;
    const digest = await candidateHash({
      templateId: release.templateId,
      orgId: release.orgId,
      mode: release.mode,
      provider: 'apple',
      version: release.version,
      contentHash: release.contentHash,
      adapterRevision: release.adapterRevision,
      adapterCapabilities: release.adapterCapabilities,
      audiencePolicyRevision: release.audiencePolicyRevision,
      authorId: candidate?.authorId ?? null,
      versionAuthorId: candidate?.versionAuthorId ?? null,
      createdAt: candidate?.createdAt ?? release.createdAt,
    });
    if (digest !== release.candidateHash) return null;
  } catch (error) {
    if (error instanceof ReleaseContentError) return null;
    throw error;
  }
  return { release, version };
}
