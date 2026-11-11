import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { AssetEntry, PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { stylesOf } from '../templates/package/slots.ts';
import type { Candidate } from './repo-lookup.ts';

/** Original scalar version columns and their parsed registry values, never a scanner DTO. */
export interface CandidateTemplateReadVersion {
  version: string;
  buildKey: string | null;
  manifest: string;
  passJson: string;
  assets: string;
  report: string;
  createdBy: string | null;
  createdAt: number;
  parsedManifest: TemplateManifest;
  parsedPassJson: PassJson;
  parsedAssets: AssetEntry[];
}

export interface CandidateTemplateReadSnapshot {
  owner: {
    id: string;
    orgId: string | null;
    origin: 'baked' | 'uploaded';
    status: 'active' | 'archived';
  };
  pinned: CandidateTemplateReadVersion;
  active: CandidateTemplateReadVersion;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function scanActionShape(action: unknown): boolean {
  if (
    !record(action) ||
    typeof action.id !== 'string' ||
    typeof action.label !== 'string' ||
    typeof action.kind !== 'string' ||
    !['check_in', 'add', 'take', 'set', 'use_up'].includes(action.kind) ||
    (action.minRole !== undefined &&
      (typeof action.minRole !== 'string' ||
        !['door', 'desk', 'manager'].includes(action.minRole))) ||
    (action.repeat !== undefined &&
      (typeof action.repeat !== 'string' ||
        !['once', 'daily', 'cooldown', 'always'].includes(action.repeat)))
  )
    return false;
  if (
    !['confirm', 'allowAgain', 'notify', 'allowOnConnected'].every(
      (key) => action[key] === undefined || typeof action[key] === 'boolean',
    ) ||
    !['input', 'rewardLabel'].every(
      (key) => action[key] === undefined || typeof action[key] === 'string',
    ) ||
    !['cooldownMinutes', 'confirmAbove'].every(
      (key) => action[key] === undefined || finiteNumber(action[key]),
    )
  )
    return false;
  const amount = action.amount;
  return (
    amount === undefined ||
    finiteNumber(amount) ||
    (record(amount) &&
      finiteNumber(amount.max) &&
      (amount.default === undefined || finiteNumber(amount.default)) &&
      (amount.presets === undefined ||
        (Array.isArray(amount.presets) && amount.presets.every(finiteNumber))))
  );
}

function scanWindowShape(value: unknown): boolean {
  return (
    record(value) &&
    ['from', 'until'].every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    ['earlyMinutes', 'lateMinutes'].every(
      (key) => value[key] === undefined || finiteNumber(value[key]),
    )
  );
}

/** Check the shapes consumed by the scan policy without revalidating legacy authoring rules. */
function scanShape(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || !Array.isArray(value.actions) || !value.actions.every(scanActionShape))
    return false;
  if (
    value.flags !== undefined &&
    (!Array.isArray(value.flags) ||
      !value.flags.every(
        (flag: unknown) =>
          record(flag) &&
          typeof flag.input === 'string' &&
          typeof flag.label === 'string' &&
          (flag.equals === undefined ||
            (Array.isArray(flag.equals) &&
              flag.equals.every((item: unknown) => typeof item === 'string'))) &&
          (flag.stop === undefined || typeof flag.stop === 'boolean'),
      ))
  )
    return false;
  return (
    (value.window === undefined || scanWindowShape(value.window)) &&
    (value.lookup === undefined ||
      (record(value.lookup) && typeof value.lookup.input === 'string')) &&
    (value.display === undefined || record(value.display)) &&
    (value.access === undefined || record(value.access))
  );
}

/** Match the registry's JSON parsing, while rejecting malformed scanner source documents. */
function version(value: unknown): CandidateTemplateReadVersion | null {
  if (
    !record(value) ||
    typeof value.version !== 'string' ||
    !value.version ||
    (value.buildKey !== null && typeof value.buildKey !== 'string') ||
    typeof value.manifest !== 'string' ||
    typeof value.passJson !== 'string' ||
    typeof value.assets !== 'string' ||
    typeof value.report !== 'string' ||
    (value.createdBy !== null && typeof value.createdBy !== 'string') ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  )
    return null;
  try {
    const manifest: unknown = JSON.parse(value.manifest);
    const passJson: unknown = JSON.parse(value.passJson);
    const assets: unknown = JSON.parse(value.assets);
    const report: unknown = JSON.parse(value.report);
    if (
      !record(manifest) ||
      manifest.schema !== 1 ||
      typeof manifest.name !== 'string' ||
      !record(manifest.inputs) ||
      manifest.inputs.type !== 'object' ||
      (manifest.inputs.properties !== undefined && !record(manifest.inputs.properties)) ||
      !Array.isArray(manifest.bindings) ||
      !manifest.bindings.every((binding: unknown) => record(binding) && record(binding.to)) ||
      !record(manifest.display) ||
      manifest.display.title === undefined ||
      !scanShape(manifest.scan) ||
      !record(passJson) ||
      !Array.isArray(assets) ||
      !assets.every((asset) => record(asset) && typeof asset.name === 'string' && !!asset.name) ||
      !record(report) ||
      (report.ok !== undefined && typeof report.ok !== 'boolean') ||
      (report.issues !== undefined && !Array.isArray(report.issues))
    )
      return null;
    return {
      version: value.version,
      buildKey: value.buildKey,
      manifest: value.manifest,
      passJson: value.passJson,
      assets: value.assets,
      report: value.report,
      createdBy: value.createdBy,
      createdAt: value.createdAt,
      parsedManifest: manifest as unknown as TemplateManifest,
      parsedPassJson: passJson as unknown as PassJson,
      parsedAssets: assets as AssetEntry[],
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Decode only the original candidate SELECT; never replace it with a later registry read. */
export function readCandidateTemplateSnapshot(
  candidate: Candidate,
): CandidateTemplateReadSnapshot | null {
  if (
    !candidate.templateSnapshot ||
    typeof candidate.templateSnapshot.raw !== 'string' ||
    !candidate.activeTemplateVersion
  )
    return null;
  try {
    const raw: unknown = JSON.parse(candidate.templateSnapshot.raw);
    if (
      !record(raw) ||
      !record(raw.owner) ||
      raw.passId !== candidate.pass.id ||
      raw.orgId !== candidate.pass.orgId ||
      raw.mode !== candidate.pass.mode ||
      raw.templateId !== candidate.pass.templateId ||
      raw.pinnedVersion !== candidate.pass.templateVersion ||
      raw.issuedId !== candidate.pass.releaseId ||
      raw.owner.id !== candidate.pass.templateId ||
      (raw.owner.orgId !== null && raw.owner.orgId !== candidate.pass.orgId) ||
      (raw.owner.origin !== 'baked' && raw.owner.origin !== 'uploaded') ||
      (raw.owner.status !== 'active' && raw.owner.status !== 'archived')
    )
      return null;
    const pinned = version(raw.pinned);
    const active = version(raw.active);
    if (
      !pinned ||
      !active ||
      pinned.version !== candidate.pass.templateVersion ||
      active.version !== candidate.activeTemplateVersion
    )
      return null;
    if (
      pinned.version === active.version &&
      (pinned.buildKey !== active.buildKey ||
        pinned.manifest !== active.manifest ||
        pinned.passJson !== active.passJson ||
        pinned.assets !== active.assets ||
        pinned.report !== active.report ||
        pinned.createdBy !== active.createdBy ||
        pinned.createdAt !== active.createdAt)
    )
      return null;
    return {
      owner: {
        id: candidate.pass.templateId,
        orgId: raw.owner.orgId as string | null,
        origin: raw.owner.origin,
        status: raw.owner.status,
      },
      pinned,
      active,
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Registry-equivalent template values from the original pinned and active D1 rows. */
export function resolveCandidateReadTemplates(candidate: Candidate): {
  pinned: ResolvedTemplate;
  active: ResolvedTemplate;
} | null {
  const snapshot = readCandidateTemplateSnapshot(candidate);
  if (!snapshot) return null;
  const materialize = (row: CandidateTemplateReadVersion): ResolvedTemplate => ({
    id: snapshot.owner.id,
    version: row.version,
    orgId: snapshot.owner.orgId,
    origin: snapshot.owner.origin,
    manifest: row.parsedManifest,
    passJson: row.parsedPassJson,
    assets: row.parsedAssets,
    styles: stylesOf(row.parsedPassJson),
  });
  const pinned = materialize(snapshot.pinned);
  const active =
    snapshot.active.version === snapshot.pinned.version ? pinned : materialize(snapshot.active);
  return { pinned, active };
}
