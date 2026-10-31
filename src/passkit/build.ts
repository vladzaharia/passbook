import { Validator } from '@cfworker/json-schema';
import type { BehaviorRegistry } from './behaviors/registry.ts';
import type { SignedPass } from './sign/index.ts';
import { signPass } from './sign/index.ts';
import { type ExprScope, evaluate, isEmpty, testCondition } from './template/expr.ts';
import type { ResolvedTemplate, TemplateRegistry } from './template/registry.ts';
import type {
  Binding,
  Json,
  PassField,
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

export interface BuildPassInput {
  template: ResolvedTemplate;
  registry: TemplateRegistry;
  input: Personalization;
  server: ServerFields;
  signing: SigningMaterial;
  behaviors?: BehaviorRegistry;
  now?: Date;
}

export interface BuiltPass {
  passJson: PassJson;
  report: ValidationReport;
  signed: SignedPass;
}

/** Thrown for invalid input or a failed validation; `report` lists the problems. */
export class PassBuildError extends Error {
  readonly code: 'INVALID_INPUT' | 'INVALID_PASS' | 'BEHAVIOR';
  readonly report: ValidationReport;
  constructor(code: PassBuildError['code'], message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = 'PassBuildError';
    this.code = code;
    this.report = { ok: false, issues };
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stripDesignerIds(value: unknown): void {
  if (Array.isArray(value)) value.forEach(stripDesignerIds);
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    delete record._id;
    Object.values(record).forEach(stripDesignerIds);
  }
}

function fieldsOf(pass: PassJson): PassField[] {
  const out: PassField[] = [];
  for (const style of [
    'generic',
    'posterGeneric',
    'storeCard',
    'coupon',
    'eventTicket',
    'boardingPass',
  ] as const) {
    const dict = pass[style];
    if (!dict) continue;
    for (const group of [
      'headerFields',
      'primaryFields',
      'secondaryFields',
      'auxiliaryFields',
      'backFields',
      'additionalInfoFields',
    ] as const) {
      const fields = dict[group];
      if (Array.isArray(fields)) out.push(...fields);
    }
  }
  return out;
}

function removeFields(pass: PassJson, keys: string[]): void {
  for (const style of [
    'generic',
    'posterGeneric',
    'storeCard',
    'coupon',
    'eventTicket',
    'boardingPass',
  ] as const) {
    const dict = pass[style];
    if (!dict) continue;
    for (const group of [
      'headerFields',
      'primaryFields',
      'secondaryFields',
      'auxiliaryFields',
      'backFields',
      'additionalInfoFields',
    ] as const) {
      const fields = dict[group];
      if (Array.isArray(fields)) dict[group] = fields.filter((f) => !keys.includes(f.key));
    }
  }
}

function applyBinding(pass: PassJson, binding: Binding, scope: ExprScope): void {
  if (binding.when && !testCondition(binding.when, scope)) return;
  const to = binding.to;
  if ('field' in to) {
    const keys = Array.isArray(to.field) ? to.field : [to.field];
    if (binding.remove && testCondition(binding.remove, scope)) {
      removeFields(pass, keys);
      return;
    }
    if (binding.value === undefined) return;
    const value = evaluate(binding.value, scope);
    if (binding.omitIfEmpty && isEmpty(value)) {
      removeFields(pass, keys);
      return;
    }
    const prop = to.prop ?? 'value';
    for (const field of fieldsOf(pass))
      if (keys.includes(field.key))
        (field as Record<string, Json | undefined>)[prop] = value as Json;
    return;
  }
  if (binding.remove && testCondition(binding.remove, scope)) return;
  if (binding.value === undefined) return;
  const value = evaluate(binding.value, scope);
  if ('barcode' in to) {
    pass.barcodes?.forEach((b, i) => {
      if (to.barcode === '*' || to.barcode === i)
        (b as unknown as Record<string, Json | undefined>)[to.prop] = value;
    });
  } else if ('action' in to) {
    const action = pass.featuredActions?.find(
      (a) => (a as { identifier?: string }).identifier === to.action,
    );
    if (action && typeof action === 'object' && !Array.isArray(action)) {
      if (binding.omitIfEmpty && isEmpty(value))
        pass.featuredActions = pass.featuredActions?.filter((a) => a !== action);
      else (action as Record<string, Json | undefined>)[to.prop] = value;
    }
  }
  // Pointer targets are added by the passkit agent with the allowlist.
}

/** Applies manifest bindings to a copy of the template's pass.json. */
export function applyBindings(template: ResolvedTemplate, input: Personalization): PassJson {
  const pass = clone(template.passJson);
  const scope: ExprScope = { input, lookups: template.manifest.lookups ?? {} };
  for (const binding of template.manifest.bindings) applyBinding(pass, binding, scope);
  return pass;
}

export function validateInput(template: ResolvedTemplate, input: Personalization): void {
  const validator = new Validator(template.manifest.inputs as never, '2020-12', false);
  const result = validator.validate(input);
  if (!result.valid) {
    throw new PassBuildError(
      'INVALID_INPUT',
      'The pass input is invalid.',
      result.errors.map((e) => ({
        severity: 'error',
        code: 'INPUT',
        message: e.error,
        path: e.instanceLocation,
      })),
    );
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * resolve -> validate input -> bindings -> behaviors -> server fields -> validatePass -> sign.
 * Foundation scope: field/barcode/action bindings with interpolation and conditions.
 */
export async function buildPass(args: BuildPassInput): Promise<BuiltPass> {
  const { template, registry, input, server, signing } = args;
  validateInput(template, input);
  const pass = applyBindings(template, input);

  for (const use of template.manifest.behaviors ?? []) {
    const plugin = args.behaviors?.get(use.use);
    if (!plugin)
      throw new PassBuildError('BEHAVIOR', `Unknown behavior ${use.use}.`, [
        { severity: 'error', code: 'BEHAVIOR', message: `Unknown behavior ${use.use}.` },
      ]);
    plugin.apply(pass, input, use.config, {
      now: args.now ?? new Date(),
      identity: server.identity,
      lookups: template.manifest.lookups ?? {},
    });
  }

  stripDesignerIds(pass);
  pass.formatVersion = 1;
  pass.passTypeIdentifier = server.identity.passTypeIdentifier;
  pass.teamIdentifier = server.identity.teamIdentifier;
  pass.serialNumber = server.serial;
  pass.authenticationToken = server.authToken;
  pass.webServiceURL = server.webServiceURL;
  pass.organizationName = server.organizationName;

  const report = validatePass(pass, template.assets, server.identity);
  if (!report.ok)
    throw new PassBuildError('INVALID_PASS', 'The pass failed validation.', report.issues);

  const assets: Record<string, Uint8Array> = {};
  const precomputedSha1: Record<string, string> = {};
  for (const entry of template.assets) {
    assets[entry.name] = await readAll(await registry.openAsset(template, entry.name));
    if (entry.sha1) precomputedSha1[entry.name] = entry.sha1;
  }
  const signed = await signPass(pass, assets, signing, { now: args.now, precomputedSha1 });
  return { passJson: pass, report, signed };
}
