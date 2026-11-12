import type { PassJson } from '../../../passkit/types.ts';
import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireApprovedRelease, type TemplateRelease } from '../templates/releases.ts';
import { type Artifact, buildArtifact } from './builder.ts';
import { type CredentialReference, credentialReferences } from './credential-references.ts';
import {
  type ConnectionTransferContent,
  readTransferPayload,
  type TransferPass,
  type TransferRow,
} from './repo-credential-transfer-read.ts';
import { getOrg } from './repo-read-issuance.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';
import { lookupValueOf, newScanCode, primaryBarcodeMessage } from './scan-code.ts';

export const conflict = () =>
  new ConflictError(
    'The pass, release or authorization changed. Reload and retry.',
    'PASS_CONFLICT',
  );
/** The rebuilt credential would equal the live one: its pass snapshot and the refs that stay. */
export interface UnchangedCredential {
  source: TransferPass;
  stableRefs: string[];
}
export class CredentialTransferReissueRequired extends ConflictError {
  readonly credentialKeysetCommitment: string;
  /** Set only when no rotation is possible and none is needed; a verified attach may link without one. */
  readonly unchanged: UnchangedCredential | undefined;

  constructor(credentialKeysetCommitment: string, unchanged?: UnchangedCredential) {
    super(
      'This template reuses an existing scanner credential. Reissue the pass with a rotating barcode and lookup before transferring it.',
      'PASS_REISSUE_REQUIRED',
    );
    this.credentialKeysetCommitment = credentialKeysetCommitment;
    this.unchanged = unchanged;
  }
}
type AppleRelease = TemplateRelease & { provider: 'apple' };

export async function approvedForTransfer(
  ctx: ServiceContext,
  source: TransferPass,
): Promise<AppleRelease> {
  const p = source.pass;
  const release = await requireApprovedRelease(ctx, p.templateId, p.orgId, p.mode, 'apple');
  if (
    release.provider !== 'apple' ||
    release.templateId !== p.templateId ||
    release.mode !== p.mode ||
    (release.orgId !== null && release.orgId !== p.orgId)
  )
    throw conflict();
  return release as AppleRelease;
}
export function releaseSnapshot(release: AppleRelease): PassReleaseSnapshot {
  return {
    id: release.id,
    generation: release.generation,
    orgId: release.orgId,
    candidateHash: release.candidateHash,
    provider: 'apple',
  };
}
/** Clone mapped content before any await; only JSON objects and known field-source values apply. */
export function captureContent(value: ConnectionTransferContent): ConnectionTransferContent {
  let captured: unknown;
  try {
    captured = JSON.parse(JSON.stringify(value));
  } catch {
    throw new ValidationError('Invalid mapped pass content.');
  }
  if (!captured || typeof captured !== 'object' || Array.isArray(captured))
    throw new ValidationError();
  const row = captured as Record<string, unknown>;
  if (
    !row.personalization ||
    typeof row.personalization !== 'object' ||
    Array.isArray(row.personalization) ||
    !row.fieldSources ||
    typeof row.fieldSources !== 'object' ||
    Array.isArray(row.fieldSources) ||
    Object.values(row.fieldSources).some((value) => value !== 'manual' && value !== 'connection')
  )
    throw new ValidationError('Invalid mapped pass content.');
  return captured as ConnectionTransferContent;
}
export function transferPayloadAad(transferId: string, orgId: string, mode: string): string {
  return credentialAad(transferId, orgId, `pass-credential-transfer:${mode}`);
}
export async function transferContent(
  ctx: ServiceContext,
  transfer: TransferRow,
  source: TransferPass,
): Promise<ConnectionTransferContent> {
  if (transfer.source_connection_id === null)
    return { personalization: source.pass.personalization, fieldSources: source.pass.fieldSources };
  const row = await readTransferPayload(ctx.env.DB, transfer.id);
  if (!row) throw conflict();
  const raw = await decryptSecretText(
    await loadKekRing(ctx.env),
    {
      kekVersion: row.kek_version,
      iv: new Uint8Array(row.iv),
      wrappedDek: new Uint8Array(row.wrapped_dek),
      ciphertext: new Uint8Array(row.ciphertext),
    },
    transferPayloadAad(transfer.id, transfer.org_id, transfer.mode),
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw conflict();
  }
  return captureContent(decoded as ConnectionTransferContent);
}
interface NewCredentials {
  serial: string;
  authToken: string;
  scanCode: string;
}
interface TransferBuild {
  credentials: NewCredentials;
  artifact: Artifact;
  content: ConnectionTransferContent;
}
export async function buildTransfer(
  ctx: ServiceContext,
  source: TransferPass,
  release: AppleRelease,
  content: ConnectionTransferContent,
): Promise<TransferBuild> {
  const p = source.pass;
  const org = await getOrg(ctx.env.DB, p.orgId);
  if (org?.status !== 'active') throw conflict();
  const credentials = {
    serial: ctx.ids.id(),
    authToken: ctx.ids.token(),
    scanCode: newScanCode(ctx),
  };
  if (
    credentials.serial === p.serial ||
    credentials.authToken === p.authToken ||
    credentials.scanCode === p.scanCode
  )
    throw conflict();
  // The previous holder's personalization marker is retired at START and must not affect this build.
  const artifact = await buildArtifact(ctx, {
    orgId: p.orgId,
    orgName: org.name,
    branding: org.branding,
    passId: p.id,
    serial: credentials.serial,
    authToken: credentials.authToken,
    scanCode: credentials.scanCode,
    webServiceUrl: p.webServiceUrl,
    identityId: p.identityId,
    templateId: p.templateId,
    templateVersion: release.version,
    personalization: content.personalization,
    status: p.status,
    omitPassAssets: true,
    ...(p.removedAt !== null
      ? { removal: { at: p.removedAt, message: source.removalMessage } }
      : {}),
  });
  if (artifact.template.id !== release.templateId || artifact.template.version !== release.version)
    throw conflict();
  return { credentials, artifact, content };
}
function priorBarcode(source: TransferPass): string | null {
  if (!source.priorPassJson) return null;
  try {
    return primaryBarcodeMessage(JSON.parse(source.priorPassJson) as PassJson);
  } catch {
    throw conflict();
  }
}
export function retiredCredentials(
  ctx: ServiceContext,
  source: TransferPass,
): Promise<CredentialReference[]> {
  const lookupValue = source.lookupInput
    ? lookupValueOf(source.pass.personalization, source.lookupInput)
    : null;
  return credentialReferences(ctx.env, source.pass.orgId, source.pass.mode, {
    scanCode: source.pass.scanCode,
    serial: source.pass.serial,
    barcodeMessage: priorBarcode(source),
    barcodeHash: source.pass.barcodeHash,
    lookupValue,
    lookupHash: source.lookupHash,
  });
}
export async function newCredentialRefs(
  ctx: ServiceContext,
  source: TransferPass,
  build: TransferBuild,
): Promise<string[]> {
  const input = build.artifact.template.manifest.scan?.lookup?.input;
  const lookupValue = input ? lookupValueOf(build.content.personalization, input) : null;
  const refs = await credentialReferences(ctx.env, source.pass.orgId, source.pass.mode, {
    serial: build.credentials.serial,
    scanCode: build.credentials.scanCode,
    barcodeMessage: primaryBarcodeMessage(build.artifact.passJson),
    barcodeHash: build.artifact.barcodeHash,
    lookupValue,
    lookupHash: build.artifact.lookupHash,
  });
  return [...new Set(refs.map((entry) => entry.ref))];
}
/**
 * The rebuilt credential cannot differ from the live one: every reference that is not freshly
 * random (the barcode and lookup values) is already one of the pass's current references.
 */
export async function unchangedCredential(
  ctx: ServiceContext,
  source: TransferPass,
  build: TransferBuild,
  targetRefs: string[],
  oldRefs: Set<string>,
): Promise<UnchangedCredential | undefined> {
  const fresh = new Set(
    (
      await credentialReferences(ctx.env, source.pass.orgId, source.pass.mode, {
        serial: build.credentials.serial,
        scanCode: build.credentials.scanCode,
      })
    ).map((entry) => entry.ref),
  );
  const stableRefs = targetRefs.filter((ref) => !fresh.has(ref));
  return stableRefs.length > 0 && stableRefs.every((ref) => oldRefs.has(ref))
    ? { source, stableRefs }
    : undefined;
}
