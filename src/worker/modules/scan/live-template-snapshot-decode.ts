import type { TemplateVersionExtra } from '../templates/repo-preview-extras.ts';
import type {
  LiveTemplateBinding,
  LiveTemplateSnapshot,
  LiveTemplateSnapshotPurpose,
} from './repo-live-template-snapshot.ts';

export interface VersionSnapshot {
  version: string;
  buildKey: string | null;
  manifest: string;
  passJson: string;
  assets: string;
  report: string;
  createdBy: string | null;
  createdAt: number;
  extrasSeal: string | null;
  extras: TemplateVersionExtra[];
}

export interface ReleaseSnapshot {
  id: string;
  generation: number;
  templateId: string;
  orgId: string | null;
  mode: string;
  provider: string;
  version: string;
  candidateHash: string;
  contentHash: string;
  adapterRevision: number;
  adapterCapabilities: string;
  audiencePolicyRevision: number;
  source: string;
  action: string;
  candidateId: string | null;
  approvalId: string | null;
  createdAt: number;
  candidate: Record<string, unknown> | null;
  approval: Record<string, unknown> | null;
}

export interface Snapshot {
  passId: string;
  orgId: string;
  mode: 'live' | 'test';
  templateId: string;
  pinnedVersion: string;
  issuedId: string | null;
  owner: { id: string; orgId: string | null; origin: 'baked' | 'uploaded'; status: string };
  pinned: VersionSnapshot;
  active: VersionSnapshot;
  release: ReleaseSnapshot | null;
  issued: ReleaseSnapshot | null;
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function parse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function version(value: unknown): value is VersionSnapshot {
  return (
    object(value) &&
    text(value.version) &&
    nullableText(value.buildKey) &&
    typeof value.manifest === 'string' &&
    typeof value.passJson === 'string' &&
    typeof value.assets === 'string' &&
    typeof value.report === 'string' &&
    nullableText(value.createdBy) &&
    integer(value.createdAt) &&
    nullableText(value.extrasSeal) &&
    Array.isArray(value.extras) &&
    value.extras.every(
      (extra: unknown) =>
        object(extra) &&
        text(extra.name) &&
        integer(extra.size) &&
        extra.size >= 0 &&
        typeof extra.sha1 === 'string' &&
        /^[a-f0-9]{40}$/.test(extra.sha1) &&
        hex(extra.sha256) &&
        text(extra.r2Key),
    )
  );
}

function release(value: unknown): value is ReleaseSnapshot {
  return (
    object(value) &&
    text(value.id) &&
    integer(value.generation) &&
    value.generation > 0 &&
    text(value.templateId) &&
    nullableText(value.orgId) &&
    text(value.mode) &&
    value.provider === 'apple' &&
    text(value.version) &&
    hex(value.candidateHash) &&
    hex(value.contentHash) &&
    integer(value.adapterRevision) &&
    typeof value.adapterCapabilities === 'string' &&
    integer(value.audiencePolicyRevision) &&
    text(value.source) &&
    text(value.action) &&
    nullableText(value.candidateId) &&
    nullableText(value.approvalId) &&
    integer(value.createdAt) &&
    (value.candidate === null || object(value.candidate)) &&
    (value.approval === null || object(value.approval))
  );
}

/** Decode the original SQL projection and match it to the fields from that same Candidate. */
export function decodeBoundLiveTemplateSnapshot(
  binding: LiveTemplateBinding,
  snapshot: LiveTemplateSnapshot | null,
  purpose: LiveTemplateSnapshotPurpose,
): Snapshot | null {
  if (!snapshot || typeof snapshot.raw !== 'string' || (purpose !== 'read' && purpose !== 'commit'))
    return null;
  const value = parse(snapshot.raw);
  if (
    !object(value) ||
    !text(value.passId) ||
    !text(value.orgId) ||
    (value.mode !== 'live' && value.mode !== 'test') ||
    !text(value.templateId) ||
    !text(value.pinnedVersion) ||
    !nullableText(value.issuedId) ||
    !object(value.owner) ||
    !text(value.owner.id) ||
    !nullableText(value.owner.orgId) ||
    (value.owner.origin !== 'baked' && value.owner.origin !== 'uploaded') ||
    (value.owner.status !== 'active' && value.owner.status !== 'archived') ||
    !version(value.pinned) ||
    !version(value.active) ||
    (value.release !== null && !release(value.release)) ||
    (value.issued !== null && !release(value.issued))
  )
    return null;
  const s = value as unknown as Snapshot;
  const p = binding.pass;
  if (
    !p ||
    s.passId !== p.id ||
    s.orgId !== p.orgId ||
    s.mode !== p.mode ||
    s.templateId !== p.templateId ||
    s.pinnedVersion !== p.templateVersion ||
    s.issuedId !== p.releaseId ||
    s.owner.id !== p.templateId ||
    (s.owner.orgId !== null && s.owner.orgId !== p.orgId) ||
    s.pinned.version !== p.templateVersion ||
    s.active.version !== binding.activeTemplateVersion ||
    (s.issued === null ? p.releaseId !== null : s.issued.id !== p.releaseId)
  )
    return null;
  if (s.release === null) {
    return p.releaseId === null &&
      binding.activeReleaseId === null &&
      binding.activeReleaseGeneration === null &&
      binding.activeReleaseVersion === null &&
      binding.activeReleaseCandidateHash === null &&
      binding.activeTemplateVersion === p.templateVersion &&
      binding.displayTemplateVersion === p.templateVersion
      ? s
      : null;
  }
  const r = s.release;
  const compatible =
    s.active.version === s.pinned.version ||
    (s.pinned.buildKey !== null &&
      s.active.buildKey !== null &&
      s.pinned.buildKey === s.active.buildKey);
  const displayVersion = compatible ? r.version : null;
  return (purpose === 'read' || compatible) &&
    r.id === binding.activeReleaseId &&
    r.generation === binding.activeReleaseGeneration &&
    r.version === binding.activeReleaseVersion &&
    r.candidateHash === binding.activeReleaseCandidateHash &&
    r.version === s.active.version &&
    binding.displayTemplateVersion === displayVersion
    ? s
    : null;
}
