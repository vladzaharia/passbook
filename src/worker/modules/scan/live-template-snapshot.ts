import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { scanManifestIssues } from '../../../passkit/template/scan.ts';
import type { AssetEntry, PassJson, TemplateManifest } from '../../../passkit/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { stylesOf } from '../templates/package/slots.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
  candidateHash,
  ReleaseContentError,
  templateContentHash,
} from '../templates/release-content.ts';
import { versionExtrasHash } from '../templates/repo-preview-extras.ts';
import {
  decodeBoundLiveTemplateSnapshot,
  hex,
  integer,
  object,
  parse,
  type ReleaseSnapshot,
  type Snapshot,
  text,
  type VersionSnapshot,
} from './live-template-snapshot-decode.ts';
import type {
  LiveTemplateBinding,
  LiveTemplateSnapshot,
  LiveTemplateSnapshotPurpose,
} from './repo-live-template-snapshot.ts';

export { decodeBoundLiveTemplateSnapshot };

interface DecodedVersion {
  resolved: ResolvedTemplate;
  reportOk: boolean;
}

function decodeVersion(value: VersionSnapshot, snapshot: Snapshot): DecodedVersion | null {
  const manifest = parse(value.manifest);
  const passJson = parse(value.passJson);
  const assets = parse(value.assets);
  const report = parse(value.report);
  if (
    !object(manifest) ||
    manifest.schema !== 1 ||
    !text(manifest.name) ||
    !object(manifest.inputs) ||
    manifest.inputs.type !== 'object' ||
    !object(manifest.sample) ||
    !Array.isArray(manifest.bindings) ||
    !manifest.bindings.every((binding: unknown) => object(binding) && object(binding.to)) ||
    !object(manifest.display) ||
    manifest.display.title === undefined ||
    (manifest.scan !== undefined &&
      (!object(manifest.scan) || !Array.isArray(manifest.scan.actions))) ||
    !object(passJson) ||
    !Array.isArray(assets) ||
    !object(report) ||
    (report.ok !== undefined && typeof report.ok !== 'boolean') ||
    (report.issues !== undefined && !Array.isArray(report.issues))
  )
    return null;
  const names = new Set<string>();
  for (const asset of assets as unknown[]) {
    if (!object(asset) || !text(asset.name) || names.has(asset.name)) return null;
    names.add(asset.name);
  }
  const pass = passJson as unknown as PassJson;
  const templateManifest = manifest as unknown as TemplateManifest;
  try {
    if (
      scanManifestIssues(templateManifest, { passJson: pass, assetNames: [...names] }).some(
        (issue) => issue.severity === 'error',
      )
    )
      return null;
  } catch (error) {
    // Malformed stored scanner documents must not reach the renderer or policy engine.
    if (error instanceof TypeError || error instanceof RangeError) return null;
    throw error;
  }
  return {
    resolved: {
      id: snapshot.templateId,
      version: value.version,
      orgId: snapshot.owner.orgId,
      origin: snapshot.owner.origin,
      manifest: templateManifest,
      passJson: pass,
      assets: assets as AssetEntry[],
      styles: stylesOf(pass),
    },
    reportOk: report.ok !== false,
  };
}

function sameVersion(a: VersionSnapshot, b: VersionSnapshot): boolean {
  return (
    a.version === b.version &&
    a.buildKey === b.buildKey &&
    a.manifest === b.manifest &&
    a.passJson === b.passJson &&
    a.assets === b.assets &&
    a.report === b.report &&
    a.createdBy === b.createdBy &&
    a.createdAt === b.createdAt &&
    a.extrasSeal === b.extrasSeal &&
    a.extras.length === b.extras.length &&
    a.extras.every((extra, index) => {
      const other = b.extras[index];
      return (
        other !== undefined &&
        extra.name === other.name &&
        extra.size === other.size &&
        extra.sha1 === other.sha1 &&
        extra.sha256 === other.sha256 &&
        extra.r2Key === other.r2Key
      );
    })
  );
}

async function extrasValid(snapshot: Snapshot, value: VersionSnapshot): Promise<boolean> {
  if (snapshot.owner.origin === 'uploaded')
    return value.extrasSeal === null && value.extras.length === 0;
  return hex(value.extrasSeal) && value.extrasSeal === (await versionExtrasHash(value.extras));
}

async function releaseValid(
  snapshot: Snapshot,
  value: VersionSnapshot,
  decoded: DecodedVersion,
  r: ReleaseSnapshot,
  current: boolean,
  contentHash: string,
): Promise<boolean> {
  if (
    r.templateId !== snapshot.templateId ||
    r.mode !== snapshot.mode ||
    r.version !== value.version ||
    r.contentHash !== contentHash ||
    (r.orgId !== null && r.orgId !== snapshot.orgId)
  )
    return false;
  const caps = parse(r.adapterCapabilities);
  if (!Array.isArray(caps) || caps.some((item) => typeof item !== 'string')) return false;
  if (
    current &&
    (r.adapterRevision !== APPLE_ADAPTER_REVISION ||
      r.audiencePolicyRevision !== AUDIENCE_POLICY_REVISION ||
      JSON.stringify(caps) !== JSON.stringify(APPLE_ADAPTER_CAPABILITIES))
  )
    return false;
  let envelope: object;
  if (r.source === 'legacy') {
    // Grandfathered at cutover: no candidate or approval exists; the hashes are provenance markers.
    return (
      snapshot.owner.origin === 'uploaded' &&
      r.orgId === snapshot.orgId &&
      r.action === 'legacy' &&
      r.generation === 1 &&
      r.candidateId === null &&
      r.approvalId === null &&
      r.candidate === null &&
      r.approval === null
    );
  }
  if (r.source === 'system') {
    if (
      snapshot.owner.origin !== 'baked' ||
      r.orgId !== snapshot.owner.orgId ||
      r.action !== 'system' ||
      r.candidateId !== null ||
      r.approvalId !== null ||
      r.candidate !== null ||
      r.approval !== null
    )
      return false;
    envelope = {
      templateId: r.templateId,
      orgId: r.orgId,
      mode: r.mode,
      provider: r.provider,
      version: r.version,
      contentHash: r.contentHash,
      adapterRevision: r.adapterRevision,
      adapterCapabilities: caps,
      audiencePolicyRevision: r.audiencePolicyRevision,
      authorId: null,
      versionAuthorId: null,
      createdAt: r.createdAt,
    };
  } else {
    const c = r.candidate;
    const a = r.approval;
    if (
      r.source !== 'approved' ||
      snapshot.owner.origin !== 'uploaded' ||
      r.orgId !== snapshot.orgId ||
      (r.action !== 'release' && r.action !== 'rollback') ||
      !c ||
      !a ||
      !decoded.reportOk ||
      !text(r.candidateId) ||
      !text(r.approvalId) ||
      c.id !== r.candidateId ||
      a.id !== r.approvalId ||
      a.candidateId !== c.id ||
      a.candidateHash !== r.candidateHash ||
      !text(a.reviewerId) ||
      !text(c.authorId) ||
      a.reviewerId === c.authorId ||
      a.reviewerId === c.versionAuthorId ||
      c.templateId !== r.templateId ||
      c.orgId !== r.orgId ||
      c.mode !== r.mode ||
      c.provider !== r.provider ||
      c.version !== r.version ||
      c.candidateHash !== r.candidateHash ||
      c.contentHash !== r.contentHash ||
      c.adapterRevision !== r.adapterRevision ||
      c.adapterCapabilities !== r.adapterCapabilities ||
      c.audiencePolicyRevision !== r.audiencePolicyRevision ||
      c.versionAuthorId !== value.createdBy ||
      !integer(c.createdAt)
    )
      return false;
    envelope = {
      templateId: c.templateId,
      orgId: c.orgId,
      mode: c.mode,
      provider: c.provider,
      version: c.version,
      contentHash: c.contentHash,
      adapterRevision: c.adapterRevision,
      adapterCapabilities: caps,
      audiencePolicyRevision: c.audiencePolicyRevision,
      authorId: c.authorId,
      versionAuthorId: c.versionAuthorId,
      createdAt: c.createdAt,
    };
  }
  return (await candidateHash(envelope)) === r.candidateHash;
}

/**
 * Verify the original Candidate projection and real asset bytes without another D1 request.
 * `read` can return an incompatible approved head for policy inspection; callers must not use it
 * as display authority when binding.displayTemplateVersion is null. `commit` rejects that state.
 */
export async function verifyLiveTemplateSnapshot(
  ctx: ServiceContext,
  binding: LiveTemplateBinding,
  snapshot: LiveTemplateSnapshot | null,
  purpose: LiveTemplateSnapshotPurpose,
): Promise<{ pinned: ResolvedTemplate; active: ResolvedTemplate } | null> {
  const s = decodeBoundLiveTemplateSnapshot(binding, snapshot, purpose);
  if (!s) return null;
  const pinned = decodeVersion(s.pinned, s);
  const active = s.active.version === s.pinned.version ? pinned : decodeVersion(s.active, s);
  if (!pinned || !active) return null;
  // A same-version row must be identical, not merely named the same.
  if (s.active.version === s.pinned.version && !sameVersion(s.active, s.pinned)) return null;
  try {
    if (!(await extrasValid(s, s.pinned))) return null;
    if (s.active.version !== s.pinned.version && !(await extrasValid(s, s.active))) return null;
    const pinnedHash = await templateContentHash(ctx, pinned.resolved, s.pinned.extras);
    const activeHash =
      s.active.version === s.pinned.version
        ? pinnedHash
        : await templateContentHash(ctx, active.resolved, s.active.extras);
    if (s.issued && !(await releaseValid(s, s.pinned, pinned, s.issued, false, pinnedHash)))
      return null;
    if (s.release && !(await releaseValid(s, s.active, active, s.release, true, activeHash)))
      return null;
    return { pinned: pinned.resolved, active: active.resolved };
  } catch (error) {
    if (error instanceof ReleaseContentError || error instanceof RangeError) return null;
    throw error;
  }
}
