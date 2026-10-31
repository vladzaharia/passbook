import { cachedAssetBytes } from './asset-cache.ts';
import type { BehaviorRegistry } from './behaviors/registry.ts';
import { normalizePass } from './schema/normalize.ts';
import type { SignedPass } from './sign/index.ts';
import { sha1Hex, signPass } from './sign/index.ts';
import { bindPass } from './template/bindings.ts';
import { applyDefaults, checkInput } from './template/manifest.ts';
import { unmetRequirements } from './template/requires.ts';
import { classifyAsset, pngSize, slotOf } from './template/package.ts';
import type { ResolvedTemplate, TemplateRegistry } from './template/registry.ts';
import type {
  PassIdentity,
  PassJson,
  Personalization,
  SigningMaterial,
  ValidationIssue,
  ValidationReport,
} from './types.ts';
import { validatePass } from './validate.ts';

export interface ServerFields {
  serial: string;
  authToken: string;
  webServiceURL: string;
  organizationName: string;
  identity: PassIdentity;
}

/** A per-pass image. Replaces the template file of the same name. */
export interface AssetOverride {
  bytes: Uint8Array;
  /** Known SHA-1 (hex); skips hashing. */
  sha1?: string;
}

export interface BuildPassInput {
  template: ResolvedTemplate;
  registry: TemplateRegistry;
  input: Personalization;
  server: ServerFields;
  signing: SigningMaterial;
  behaviors?: BehaviorRegistry;
  /** Signing time and behavior clock. Identical input and `now` give identical output. */
  now?: Date;
  /** Per-pass images by file name (`thumbnail@2x.png`). */
  assetOverrides?: Record<string, AssetOverride>;
  /** `contentHash` of the pass being replaced. A match skips signing unless `force` is set. */
  previousHash?: string;
  force?: boolean;
}

export interface BuiltPass {
  passJson: PassJson;
  report: ValidationReport;
  signed: SignedPass;
  /** SHA-256 of pass.json content plus asset digests. Independent of signing time. */
  contentHash: string;
  changed: true;
}

export interface UnchangedPass {
  passJson: PassJson;
  report: ValidationReport;
  contentHash: string;
  changed: false;
}

/** Thrown for invalid input or a failed validation; `report` lists the problems. */
export class PassBuildError extends Error {
  readonly code: 'INVALID_INPUT' | 'INVALID_PASS' | 'BEHAVIOR' | 'TEMPLATE';
  readonly report: ValidationReport;
  constructor(code: PassBuildError['code'], message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = 'PassBuildError';
    this.code = code;
    this.report = { ok: false, issues };
  }
}

function fail(code: PassBuildError['code'], message: string, path?: string): never {
  throw new PassBuildError(code, message, [
    {
      severity: 'error',
      code: code === 'INVALID_INPUT' ? 'INPUT' : code,
      message,
      ...(path ? { path } : {}),
    },
  ]);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Applies manifest bindings to a copy of the template's pass.json. */
export function applyBindings(template: ResolvedTemplate, input: Personalization): PassJson {
  return bindPass(template, input).pass;
}

export function validateInput(template: ResolvedTemplate, input: Personalization): void {
  const issues = checkInput(template.manifest, input);
  if (issues.length > 0)
    throw new PassBuildError('INVALID_INPUT', 'The pass input is invalid.', issues);
}

interface ShippedAsset {
  name: string;
  width?: number;
  height?: number;
  sha1?: string;
  crc32?: number;
  bytes?: Uint8Array;
}

/** Template files minus preview-only and dropped slots, with per-pass overrides applied. */
function shippedAssets(
  template: ResolvedTemplate,
  dropped: string[],
  overrides: Record<string, AssetOverride>,
): ShippedAsset[] {
  const previewOnly = new Set(template.manifest.previewOnlyAssets ?? []);
  const isDropped = (name: string) => {
    const slot = slotOf(name);
    return slot !== null && dropped.includes(slot);
  };
  const out = new Map<string, ShippedAsset>();
  for (const entry of template.assets) {
    if (previewOnly.has(entry.name) || isDropped(entry.name)) continue;
    out.set(entry.name, {
      name: entry.name,
      ...(entry.width ? { width: entry.width } : {}),
      ...(entry.height ? { height: entry.height } : {}),
      ...(entry.sha1 ? { sha1: entry.sha1 } : {}),
      ...(entry.crc32 !== undefined ? { crc32: entry.crc32 } : {}),
    });
  }
  for (const [name, override] of Object.entries(overrides)) {
    const kind = classifyAsset(name);
    if (!kind || kind.slot === 'other' || kind.slot === 'strings')
      fail('INVALID_INPUT', `${name} is not an image slot file.`, `assetOverrides/${name}`);
    if (isDropped(name)) continue;
    const size = pngSize(override.bytes);
    if (!size) fail('INVALID_INPUT', `${name} is not a PNG.`, `assetOverrides/${name}`);
    out.set(name, {
      name,
      ...size,
      bytes: override.bytes,
      ...(override.sha1 ? { sha1: override.sha1 } : {}),
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface PlannedPass {
  passJson: PassJson;
  report: ValidationReport;
  assets: ShippedAsset[];
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

/** Everything up to and including validation. No I/O, no signing. */
export function planPass(args: BuildPassInput): PlannedPass {
  const { template, input, server } = args;
  validateInput(template, input);
  const unmet = unmetRequirements(template.manifest, server.identity);
  if (unmet.length > 0) fail('TEMPLATE', unmet.join(' '), 'requires');
  let pass: PassJson;
  let dropped: string[];
  try {
    ({ pass, droppedImages: dropped } = bindPass(template, input));
  } catch (error) {
    if (error instanceof Error) fail('TEMPLATE', `Binding failed: ${error.message}`);
    throw error;
  }

  const full = applyDefaults(template.manifest, input);
  for (const use of template.manifest.behaviors ?? []) {
    const plugin = args.behaviors?.get(use.use);
    if (!plugin) fail('BEHAVIOR', `Unknown behavior ${use.use}.`);
    try {
      plugin.apply(pass, full, use.config, {
        now: args.now ?? new Date(),
        identity: server.identity,
        lookups: template.manifest.lookups ?? {},
      });
    } catch (error) {
      fail('BEHAVIOR', `${use.use} failed: ${(error as Error).message}`);
    }
  }

  pass = normalizePass(pass);
  pass.formatVersion = 1;
  pass.passTypeIdentifier = server.identity.passTypeIdentifier;
  pass.teamIdentifier = server.identity.teamIdentifier;
  pass.serialNumber = server.serial;
  pass.authenticationToken = server.authToken;
  pass.webServiceURL = server.webServiceURL;
  pass.organizationName = server.organizationName;

  const assets = shippedAssets(template, dropped, args.assetOverrides ?? {});
  const report = validatePass(pass, assets, server.identity);
  if (!report.ok)
    throw new PassBuildError('INVALID_PASS', 'The pass failed validation.', report.issues);
  return { passJson: pass, report, assets };
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
  const { template, registry, signing } = args;
  const plan = planPass(args);

  const bytes: Record<string, Uint8Array> = {};
  const sha1: Record<string, string> = {};
  const crc: Record<string, number> = {};
  for (const asset of plan.assets) {
    bytes[asset.name] =
      asset.bytes ??
      (await cachedAssetBytes(template.id, template.version, asset, async () =>
        readAll(await registry.openAsset(template, asset.name)),
      ));
    sha1[asset.name] = asset.sha1 ?? (await sha1Hex(bytes[asset.name] as Uint8Array));
    if (asset.crc32 !== undefined) crc[asset.name] = asset.crc32;
  }
  checkPackageContents(plan, bytes, args.server.identity);
  const contentHash = await sha256Hex(
    `${canonical(plan.passJson)}\n${Object.keys(sha1)
      .sort()
      .map((name) => `${name}:${sha1[name]}`)
      .join('\n')}`,
  );
  if (args.previousHash === contentHash && !args.force)
    return { passJson: plan.passJson, report: plan.report, contentHash, changed: false };

  const signed = await signPass(plan.passJson, bytes, signing, {
    now: args.now,
    precomputedSha1: sha1,
    precomputedCrc32: crc,
  });
  return { passJson: plan.passJson, report: plan.report, signed, contentHash, changed: true };
}
