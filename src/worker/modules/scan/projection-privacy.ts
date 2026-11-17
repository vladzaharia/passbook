import { exprReferences } from '../../../passkit/template/expr.ts';
import {
  hasContactShape,
  isPrivateName,
  leaksSecret,
  secretSpellings,
} from '../../../passkit/template/scan-display/privacy.ts';
import {
  barcodeOnlyInputs,
  type InputSchema,
  inputProps,
  inputVisibleTo,
  isSecretInput,
  secretInputs,
} from '../../../passkit/template/scan-display/scope.ts';
import type { Json, Personalization } from '../../../passkit/types.ts';
import { displayOf } from '../passes/builder.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function sourceAllowed(
  actor: ScanActor,
  name: string,
  schema: unknown,
  secrets: Set<string>,
): boolean {
  const prop = objectOf(schema);
  return (
    actor.role !== null &&
    prop !== null &&
    !isPrivateName(name) &&
    inputVisibleTo(name, prop as InputSchema, actor.role, secrets)
  );
}

/** The values behind secret inputs (contact, credential, barcode-only), whole, at any depth. */
function secretInputValues(found: Found): unknown[] {
  const values: unknown[] = [];
  const walk = (name: string, value: unknown, schema: unknown, secret: boolean): void => {
    const prop = objectOf(schema);
    const secretHere =
      secret || isPrivateName(name) || (!!prop && isSecretInput(name, prop as InputSchema));
    if (secretHere) {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(name, item, prop?.items, false);
    } else if (value && typeof value === 'object') {
      const children = objectOf(prop?.properties);
      for (const [key, child] of Object.entries(value)) walk(key, child, children?.[key], false);
    }
  };
  const manifests = [found.template.manifest];
  const active = found.activePolicy ?? found.activeTemplate;
  if (active && active.manifest !== found.template.manifest) manifests.push(active.manifest);
  for (const manifest of manifests) {
    const props = inputProps(manifest);
    const barcodeOnly = barcodeOnlyInputs(manifest);
    for (const [name, schema] of Object.entries(props)) {
      const secret = barcodeOnly.has(name);
      if (Object.hasOwn(schema, 'default')) walk(name, schema.default, schema, secret);
      if (Object.hasOwn(found.pass.personalization, name))
        walk(name, found.pass.personalization[name], schema, secret);
    }
  }
  // An undeclared input has no schema to judge it: only its name can mark it secret.
  for (const [name, value] of Object.entries(found.pass.personalization))
    if (isPrivateName(name)) values.push(value);
  return values;
}

/**
 * The pass's secrets, in every spelling they can reach text: credentials, scan code, holder
 * email, the barcode and NFC messages, opaque Wallet metadata, and the values of secret inputs
 * (passwords, tokens, contacts). Other holder inputs are not here: which of those a role may
 * see is provenance (`sourceAllowed`), not a value match.
 */
export function passSecretSpellings(found: Found): string[] {
  const { pass, passJson } = found;
  return secretSpellings(
    pass.serial,
    pass.authToken,
    pass.downloadToken,
    pass.webServiceUrl,
    pass.scanCode,
    pass.holderEmail,
    passJson.serialNumber,
    passJson.authenticationToken,
    passJson.webServiceURL,
    passJson.barcode?.message,
    passJson.barcode?.altText,
    ...(Array.isArray(passJson.barcodes)
      ? passJson.barcodes.flatMap((barcode) => [barcode?.message, barcode?.altText])
      : []),
    passJson.nfc,
    passJson.userInfo,
    secretInputValues(found),
  );
}

/** A leaf is display data unless it is a secret, a contact address or a link. Keys are checked by name. */
export function scanValueSafe(
  found: Found,
  value: unknown,
  secrets: readonly string[] = passSecretSpellings(found),
): boolean {
  const safe = (part: unknown): boolean => {
    if (typeof part === 'string') return !hasContactShape(part) && !leaksSecret(part, secrets);
    if (typeof part === 'number') return !leaksSecret(part, secrets);
    if (Array.isArray(part)) return part.every(safe);
    if (part && typeof part === 'object')
      return Object.entries(part).every(([key, child]) => !isPrivateName(key) && safe(child));
    return true;
  };
  return safe(value);
}

/** Project the schema recursively rather than shipping a role-filtered top-level object unchanged. */
export function projectScanInputs(found: Found, actor: ScanActor): Personalization {
  const secrets = secretInputs(found.template.manifest);
  const leaks = passSecretSpellings(found);
  const active = found.activePolicy ?? found.activeTemplate ?? found.template;
  const activeSecrets = secretInputs(active.manifest);
  const omitted = Symbol('omitted');
  const visit = (
    name: string,
    value: unknown,
    schema: unknown,
    activeSchema: unknown,
  ): Json | typeof omitted => {
    if (
      !sourceAllowed(actor, name, schema, secrets) ||
      !sourceAllowed(actor, name, activeSchema, activeSecrets)
    )
      return omitted;
    const prop = objectOf(schema);
    const activeProp = objectOf(activeSchema);
    if (Array.isArray(value)) {
      const items = value.map((item) => visit(name, item, prop?.items, activeProp?.items));
      return items.filter((item): item is Json => item !== omitted);
    }
    const record = objectOf(value);
    if (record) {
      const children = objectOf(prop?.properties);
      const activeChildren = objectOf(activeProp?.properties);
      const result: Record<string, Json> = {};
      for (const [key, child] of Object.entries(record)) {
        const projected = visit(key, child, children?.[key], activeChildren?.[key]);
        if (projected !== omitted) result[key] = projected;
      }
      return result;
    }
    return value !== undefined && scanValueSafe(found, value, leaks) ? (value as Json) : omitted;
  };
  const props = inputProps(found.template.manifest);
  const activeProps = inputProps(active.manifest);
  const projected: Personalization = {};
  for (const [name, value] of Object.entries(found.pass.personalization)) {
    const result = visit(name, value, props[name], activeProps[name]);
    if (result !== omitted) projected[name] = result;
  }
  return projected;
}

/** A raw action value is visible only if its whole source survived the recursive projection. */
export function scanInputVisible(found: Found, actor: ScanActor, input: string): boolean {
  const path = input.split('.');
  let original: unknown = found.pass.personalization;
  let projected: unknown = projectScanInputs(found, actor);
  for (const key of path) {
    const before = objectOf(original);
    const after = objectOf(projected);
    if (!before || !after || !Object.hasOwn(after, key)) return false;
    original = before[key];
    projected = after[key];
  }
  return JSON.stringify(original) === JSON.stringify(projected);
}

/** Re-evaluate public identity expressions only when every input they depend on is visible. */
export function scanIdentity(
  found: Found,
  actor: ScanActor,
): {
  title: string | null;
  subtitle: string | null;
} {
  const manifest = found.template.manifest;
  const visible = projectScanInputs(found, actor);
  let display: { title: string | null; subtitle: string | null };
  try {
    display = displayOf(found.template, visible);
  } catch {
    return { title: null, subtitle: null };
  }
  const permitted = (
    expr: typeof manifest.display.subtitle,
    value: string | null,
  ): string | null => {
    if (expr === undefined || value === null || !scanValueSafe(found, value)) return null;
    try {
      if (typeof expr === 'string' && /\{\{\s*pass(?:[.\s|}]|\[|$)/.test(expr)) return null;
      if (exprReferences(expr).inputs.some((name) => !Object.hasOwn(visible, name))) return null;
      return value;
    } catch {
      return null;
    }
  };
  return {
    title: permitted(manifest.display.title, display.title),
    subtitle: permitted(manifest.display.subtitle, display.subtitle),
  };
}
