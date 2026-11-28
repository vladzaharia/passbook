import { cachedAssetBytes } from './asset-cache.ts';
import { contentHashOf } from './build-hash.ts';
import { fail, PassBuildError, type PlanInput, type PlannedPass, planPass } from './plan.ts';
import type { SignedPass } from './sign/index.ts';
import { sha1Hex, signPass } from './sign/index.ts';
import type { PassIdentity, PassJson, SigningMaterial, ValidationReport } from './types.ts';
import { validatePass } from './validate.ts';

export type { AssetOverride, PlanInput, PlannedPass, ServerFields } from './plan.ts';
export { applyBindings, PassBuildError, planPass, validateInput } from './plan.ts';

export interface BuildPassInput extends PlanInput {
  signing: SigningMaterial;
  /** `contentHash` of the pass being replaced. A match skips signing unless `force` is set. */
  previousHash?: string;
  force?: boolean;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface BuiltPass {
  passJson: PassJson;
  report: ValidationReport;
  signed: SignedPass;
  /** SHA-256 of pass.json content plus asset digests. Independent of signing time. */
  contentHash: string;
  /** SHA-1 of each asset, as `contentHash` covers them. */
  assetSha1: Record<string, string>;
  changed: true;
}

export interface UnchangedPass {
  passJson: PassJson;
  report: ValidationReport;
  contentHash: string;
  assetSha1: Record<string, string>;
  changed: false;
}

/** Localization and personalization checks need file contents, so they run once bytes are read. */
function checkPackageContents(
  plan: PlannedPass,
  bytes: Record<string, Uint8Array>,
  identity: PassIdentity,
): void {
  const strings: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(bytes))
    if (name.endsWith('.strings')) strings[name] = data;
  const raw = bytes['personalization.json'];
  if (Object.keys(strings).length === 0 && !raw) return;
  let personalization: unknown;
  if (raw) {
    try {
      personalization = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      fail('INVALID_PASS', 'personalization.json is not valid JSON.');
    }
  }
  const report = validatePass(plan.passJson, plan.assets, identity, {
    strings,
    ...(raw ? { personalization } : {}),
  });
  if (!report.ok)
    throw new PassBuildError('INVALID_PASS', 'The pass failed validation.', report.issues);
}

interface HashedPlan {
  plan: PlannedPass;
  bytes: Record<string, Uint8Array>;
  sha1: Record<string, string>;
  crc: Record<string, number>;
  contentHash: string;
}

/** `planPass`, then every asset's bytes and the content hash. No signing. */
async function planAndHash(args: PreviewPassInput): Promise<HashedPlan> {
  const { template, registry } = args;
  const plan = planPass(args);
  const bytes: Record<string, Uint8Array> = {};
  const sha1: Record<string, string> = {};
  const crc: Record<string, number> = {};
  for (const asset of plan.assets) {
    bytes[asset.name] =
      asset.bytes ??
      (await cachedAssetBytes(template.id, template.version, asset, async () =>
        readAll(await registry.openAsset(template, asset.source ?? asset.name)),
      ));
    sha1[asset.name] = asset.sha1 ?? (await sha1Hex(bytes[asset.name] as Uint8Array));
    if (asset.crc32 !== undefined) crc[asset.name] = asset.crc32;
  }
  checkPackageContents(plan, bytes, args.server.identity);
  const contentHash = await contentHashOf(plan.passJson, sha1);
  return { plan, bytes, sha1, crc, contentHash };
}

const hashed = (plan: PlannedPass, contentHash: string, assetSha1: Record<string, string>) => ({
  passJson: plan.passJson,
  report: plan.report,
  contentHash,
  assetSha1,
});

/** The input of a pass that is only ever previewed: no signing material exists to pass. */
export type PreviewPassInput = Omit<BuildPassInput, 'signing' | 'previousHash' | 'force'>;

export interface PreviewPass {
  passJson: PassJson;
  report: ValidationReport;
  contentHash: string;
  assetSha1: Record<string, string>;
}

/**
 * The same build as `buildPass`, stopping before the signature: the pass a developer sandbox issues. It has no
 * `signing` parameter, so no caller can sign through it.
 */
export async function buildPassPreview(args: PreviewPassInput): Promise<PreviewPass> {
  const { plan, contentHash, sha1 } = await planAndHash(args);
  return { passJson: plan.passJson, report: plan.report, contentHash, assetSha1: sha1 };
}

/**
 * resolve -> validate input -> bindings -> behaviors -> server fields -> validatePass -> sign.
 * With `previousHash` and no `force`, an unchanged pass returns without signing.
 */
export async function buildPass(
  args: BuildPassInput & { previousHash: string },
): Promise<BuiltPass | UnchangedPass>;
export async function buildPass(args: BuildPassInput): Promise<BuiltPass>;
export async function buildPass(args: BuildPassInput): Promise<BuiltPass | UnchangedPass> {
  const { signing } = args;
  const { plan, bytes, sha1, crc, contentHash } = await planAndHash(args);
  if (args.previousHash === contentHash && !args.force)
    return { ...hashed(plan, contentHash, sha1), changed: false };

  const signed = await signPass(plan.passJson, bytes, signing, {
    now: args.now,
    precomputedSha1: sha1,
    precomputedCrc32: crc,
  });
  return { ...hashed(plan, contentHash, sha1), signed, changed: true };
}
