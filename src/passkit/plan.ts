import type { BehaviorRegistry } from './behaviors/registry.ts';
import { AssetPlanError, type ShippedAsset, shippedAssets } from './build-assets.ts';
import { inputTimeZone, isTimeZone, localizeDates, localZones } from './build-local-time.ts';
import { normalizePass } from './schema/normalize.ts';
import { bindPass } from './template/bindings.ts';
import { derivedPassScope, stripCount } from './template/counters.ts';
import { applyDefaults, checkInput } from './template/manifest.ts';
import type { ResolvedTemplate, TemplateRegistry } from './template/registry.ts';
import { unmetRequirements } from './template/requires.ts';
import type {
  PassIdentity,
  PassJson,
  Personalization,
  SigningMaterial,
  ValidationIssue,
  ValidationReport,
} from './types.ts';
import { validatePass } from './validate.ts';

/** Planning a pass: everything up to validation. It has no signer, so a browser can run it. */

export interface ServerFields {
  serial: string;
  authToken: string;
  webServiceURL: string;
  organizationName: string;
  identity: PassIdentity;
  /** Bound as `{{pass.scanCode}}`. A template that reads it without one gets an empty string. */
  scanCode?: string;
}

/** A per-pass image. Replaces the template file of the same name. */
export interface AssetOverride {
  bytes: Uint8Array;
  /** Known SHA-1 (hex); skips hashing. */
  sha1?: string;
}

/** What planning a pass takes. Signing material, when a caller passes it, is never read. */
export interface PlanInput {
  template: ResolvedTemplate;
  registry: TemplateRegistry;
  input: Personalization;
  server: ServerFields;
  behaviors?: BehaviorRegistry;
  /** Signing time and behavior clock. Identical input and `now` give identical output. */
  now?: Date;
  /** The org's effective time zone, for behaviors whose template names none. */
  timeZone?: string;
  /** Per-pass images by file name (`thumbnail@2x.png`). */
  assetOverrides?: Record<string, AssetOverride>;
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

export function fail(code: PassBuildError['code'], message: string, path?: string): never {
  throw new PassBuildError(code, message, [
    {
      severity: 'error',
      code: code === 'INVALID_INPUT' ? 'INPUT' : code,
      message,
      ...(path ? { path } : {}),
    },
  ]);
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

export interface PlannedPass {
  passJson: PassJson;
  report: ValidationReport;
  assets: ShippedAsset[];
}

/** Everything up to and including validation. No I/O, no signing. */
export function planPass(args: PlanInput & { signing?: SigningMaterial }): PlannedPass {
  const { template, input, server } = args;
  validateInput(template, input);
  const unmet = unmetRequirements(template.manifest, server.identity);
  if (unmet.length > 0) fail('TEMPLATE', unmet.join(' '), 'requires');
  const derived = applyDefaults(template.manifest, input);
  let pass: PassJson;
  let dropped: string[];
  try {
    ({ pass, droppedImages: dropped } = bindPass(template, input, {
      ...(server.scanCode ? { scanCode: server.scanCode } : {}),
      ...derivedPassScope(template.manifest, derived),
    }));
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
        ...(args.timeZone ? { timeZone: args.timeZone } : {}),
        identity: server.identity,
        lookups: template.manifest.lookups ?? {},
      });
    } catch (error) {
      fail('BEHAVIOR', `${use.use} failed: ${(error as Error).message}`);
    }
  }

  const zoneInput = inputTimeZone(template.manifest.inputs, full);
  if (zoneInput?.zone !== undefined && !isTimeZone(zoneInput.zone))
    fail('INVALID_INPUT', `${zoneInput.zone} is not a time zone.`, zoneInput.key);
  localizeDates(pass, localZones(pass, zoneInput?.zone));

  pass = normalizePass(pass);
  pass.formatVersion = 1;
  pass.passTypeIdentifier = server.identity.passTypeIdentifier;
  pass.teamIdentifier = server.identity.teamIdentifier;
  pass.serialNumber = server.serial;
  pass.authenticationToken = server.authToken;
  pass.webServiceURL = server.webServiceURL;
  pass.organizationName = server.organizationName;

  let assets: ShippedAsset[];
  try {
    assets = shippedAssets(
      template,
      dropped,
      args.assetOverrides ?? {},
      stripCount(template.manifest, derived),
    );
  } catch (error) {
    if (error instanceof AssetPlanError) fail(error.code, error.message, error.path);
    throw error;
  }
  const report = validatePass(pass, assets, server.identity);
  if (!report.ok)
    throw new PassBuildError('INVALID_PASS', 'The pass failed validation.', report.issues);
  return { passJson: pass, report, assets };
}
