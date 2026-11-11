import type { TemplateReleaseScope } from '../../../shared/contracts/template-releases.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
  candidateHash as hashCandidate,
  ReleaseContentError,
  templateContentDigest,
} from './release-content.ts';
import { changed, sameScope } from './releases-domain.ts';
import { getVersion, type VersionRow } from './repo.ts';
import { listVersionExtras } from './repo-preview-extras.ts';
import { type ApprovalRow, type CandidateRow, getCandidate } from './repo-releases.ts';
import {
  getVersionHashes,
  insertVersionHashesStmt,
  type VersionHashes,
} from './repo-version-hashes.ts';

export const contentChanged = () =>
  new ConflictError(
    'The approved template content or release policy changed.',
    'TEMPLATE_CONTENT_CHANGED',
  );

export function currentPolicy(row: {
  adapterRevision: number;
  adapterCapabilities: string[];
  audiencePolicyRevision: number;
}): boolean {
  return (
    row.adapterRevision === APPLE_ADAPTER_REVISION &&
    row.audiencePolicyRevision === AUDIENCE_POLICY_REVISION &&
    JSON.stringify(row.adapterCapabilities) === JSON.stringify(APPLE_ADAPTER_CAPABILITIES)
  );
}

export function snapshot(candidate: CandidateRow) {
  return {
    templateId: candidate.templateId,
    orgId: candidate.orgId,
    mode: candidate.mode,
    provider: candidate.provider,
    version: candidate.version,
    contentHash: candidate.contentHash,
    adapterRevision: candidate.adapterRevision,
    adapterCapabilities: candidate.adapterCapabilities,
    audiencePolicyRevision: candidate.audiencePolicyRevision,
    authorId: candidate.authorId,
    versionAuthorId: candidate.versionAuthorId,
    createdAt: candidate.createdAt,
  };
}

/** Read every asset and extra and hash the bytes. Candidate creation and publication use this. */
export async function contentDigest(
  ctx: ServiceContext,
  version: VersionRow,
): Promise<VersionHashes> {
  try {
    const extras = await listVersionExtras(ctx.env.DB, version.templateId, version.version);
    const { hash, assetHashes } = await templateContentDigest(ctx, version, extras);
    return { contentHash: hash, assetHashes };
  } catch (error) {
    if (error instanceof ReleaseContentError) throw contentChanged();
    throw error;
  }
}

/** Hash the bytes and compare them with the digests saved for the version (written with its first candidate). */
export async function sealedDigest(
  ctx: ServiceContext,
  version: VersionRow,
): Promise<VersionHashes> {
  const hashes = await contentDigest(ctx, version);
  const saved = await getVersionHashes(ctx.env.DB, version.templateId, version.version);
  if (saved && JSON.stringify(saved) !== JSON.stringify(hashes)) throw contentChanged();
  return hashes;
}

/**
 * Issuance check without reading asset bytes. The digests saved at candidate creation (or baked sync)
 * must equal the released hash and must still reproduce it from the stored documents, asset metadata and
 * extras, and every stored object must still have its declared size. Byte-level substitutions that keep
 * the size are caught where the bytes are read: publication, and the pass build (sha1 and crc32).
 * A version that was released before hashes were saved is verified from its bytes once, then saved.
 */
export async function verifyStoredContent(
  ctx: ServiceContext,
  version: VersionRow,
  released: string,
): Promise<void> {
  const stored = await getVersionHashes(ctx.env.DB, version.templateId, version.version);
  if (!stored) {
    // Why: a release older than the hash table; verify the bytes this once so later issuances compare hashes.
    const hashes = await contentDigest(ctx, version);
    if (hashes.contentHash !== released) throw contentChanged();
    await insertVersionHashesStmt(
      ctx.env.DB,
      version.templateId,
      version.version,
      hashes,
      ctx.clock.now(),
    ).run();
    return;
  }
  if (stored.contentHash !== released) throw contentChanged();
  try {
    const extras = await listVersionExtras(ctx.env.DB, version.templateId, version.version);
    const { hash } = await templateContentDigest(ctx, version, extras, stored.assetHashes);
    if (hash !== released) throw contentChanged();
    const objects = [
      ...version.assets.flatMap((a) =>
        a.source.kind === 'r2' ? [{ key: a.source.key, size: a.size }] : [],
      ),
      ...extras.map((e) => ({ key: e.r2Key, size: e.size })),
    ];
    const heads = await Promise.all(objects.map((o) => ctx.env.BUCKET.head(o.key)));
    if (heads.some((head, i) => !head || head.size !== objects[i]?.size)) throw contentChanged();
  } catch (error) {
    if (error instanceof ReleaseContentError) throw contentChanged();
    throw error;
  }
}

/** Recheck the immutable envelope and the content; `deep` re-reads the bytes (publication). */
export async function verifyCandidate(
  ctx: ServiceContext,
  candidate: CandidateRow,
  deep = true,
): Promise<VersionRow> {
  if (!currentPolicy(candidate) || candidate.provider !== 'apple') throw contentChanged();
  const version = await getVersion(ctx.env.DB, candidate.templateId, candidate.version);
  if (
    !version?.report.ok ||
    version.createdBy !== candidate.versionAuthorId ||
    (await hashCandidate(snapshot(candidate))) !== candidate.candidateHash
  )
    throw contentChanged();
  if (deep) {
    if ((await contentDigest(ctx, version)).contentHash !== candidate.contentHash)
      throw contentChanged();
  } else await verifyStoredContent(ctx, version, candidate.contentHash);
  return version;
}

export function approvalMatches(approval: ApprovalRow, candidate: CandidateRow): boolean {
  return (
    approval.candidateId === candidate.id &&
    approval.candidateHash === candidate.candidateHash &&
    approval.reviewerId !== candidate.authorId &&
    approval.reviewerId !== candidate.versionAuthorId
  );
}

export async function scopedCandidate(
  ctx: ServiceContext,
  templateId: string,
  candidateId: string,
  scope: TemplateReleaseScope,
  expectedHash: string,
): Promise<CandidateRow> {
  const candidate = await getCandidate(ctx.env.DB, candidateId);
  if (!candidate || !sameScope(candidate, templateId, scope))
    throw new NotFoundError('Template candidate not found.', 'TEMPLATE_CANDIDATE_NOT_FOUND');
  if (candidate.candidateHash !== expectedHash) throw changed();
  await verifyCandidate(ctx, candidate);
  return candidate;
}
