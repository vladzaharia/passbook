import { exprReferences } from '../../../passkit/template/expr.ts';
import {
  type InputSchema,
  inputProps,
  inputVisibleTo,
  nameSegments,
  secretInputs,
} from '../../../passkit/template/scan-display/scope.ts';
import type { Json, Personalization } from '../../../passkit/types.ts';
import { displayOf } from '../passes/builder.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';

const SECRET_NAMES = new Set([
  'email',
  'phone',
  'tel',
  'mobile',
  'address',
  'contact',
  'password',
  'passcode',
  'secret',
  'token',
  'pin',
  'barcode',
  'nfc',
  'serial',
  'private',
  'credential',
  'authorization',
  'cookie',
]);
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const PHONE_VALUE = /(?:^|[^\d])\+?\d[\d ().-]{6,}\d(?:$|[^\d])/u;
const CONTACT_URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|www\.)/i;
const SECRET_KEYS = new Set([
  'apikey',
  'scancode',
  'serialnumber',
  'webserviceurl',
  'messageencoding',
]);
export const scanPrivateName = (name: string) =>
  SECRET_KEYS.has(name.replace(/[^a-z0-9]/gi, '').toLowerCase()) ||
  nameSegments(name).some((segment) => SECRET_NAMES.has(segment));

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
    !scanPrivateName(name) &&
    inputVisibleTo(name, prop as InputSchema, actor.role, secrets)
  );
}

/** Collect denied leaves as well, so copying a restricted value to another input cannot reveal it. */
function deniedValues(found: Found, actor: ScanActor): (string | number | boolean)[] {
  const denied: (string | number | boolean)[] = [];
  const secrets = secretInputs(found.template.manifest);
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value !== '') denied.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') denied.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  const visit = (name: string, value: unknown, schema: unknown): void => {
    if (!sourceAllowed(actor, name, schema, secrets)) {
      collect(value);
      return;
    }
    const prop = objectOf(schema);
    if (Array.isArray(value)) {
      for (const item of value) visit(name, item, prop?.items);
    } else if (value && typeof value === 'object') {
      const children = objectOf(prop?.properties);
      for (const [key, child] of Object.entries(value)) visit(key, child, children?.[key]);
    }
  };
  const props = inputProps(found.template.manifest);
  for (const [name, value] of Object.entries(found.pass.personalization))
    visit(name, value, props[name]);
  return denied;
}

function safeValuePredicate(found: Found, actor?: ScanActor): (value: unknown) => boolean {
  const passJson = found.passJson;
  // Wallet data is not a scanner input. Remember its private leaves solely for value
  // checks; neither the subtree nor its keys may enter a scanner projection.
  const walletStrings: string[] = [];
  const rememberWallet = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value) walletStrings.push(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      walletStrings.push(String(value));
    } else if (Array.isArray(value)) value.forEach(rememberWallet);
    else if (value && typeof value === 'object') Object.values(value).forEach(rememberWallet);
  };
  [
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
  ].forEach(rememberWallet);
  const activePolicy = found.activePolicy ?? found.activeTemplate;
  const secrets: (string | number | boolean)[] = [
    found.pass.serial,
    found.pass.authToken,
    found.pass.downloadToken,
    found.pass.webServiceUrl,
    found.pass.scanCode,
    found.pass.externalId,
    found.pass.holderEmail,
    ...(actor ? deniedValues(found, actor) : []),
    ...(actor && activePolicy ? deniedValues({ ...found, template: activePolicy }, actor) : []),
  ].filter(
    (part): part is string | number | boolean =>
      (typeof part === 'string' && part.length > 0) ||
      typeof part === 'number' ||
      typeof part === 'boolean',
  );
  const protectedStrings = [...secrets, ...walletStrings].flatMap((secret) => {
    if (typeof secret !== 'string') return [String(secret)];
    const values = [secret];
    if (/[&<>"']/.test(secret))
      values.push(
        secret
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;'),
      );
    if (/[^A-Za-z0-9_.!~*'()-]/.test(secret))
      values.push(encodeURIComponent(secret.toWellFormed()));
    return values;
  });
  const safe = (part: unknown): boolean => {
    if (typeof part === 'string')
      return (
        !EMAIL_VALUE.test(part) &&
        !CONTACT_URL.test(part) &&
        (/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(part) || !PHONE_VALUE.test(part)) &&
        !protectedStrings.some((secret) =>
          secret.length < 3 ? part === secret : part.includes(secret),
        )
      );
    if (typeof part === 'number' || typeof part === 'boolean') return !secrets.includes(part);
    if (Array.isArray(part)) return part.every(safe);
    if (part && typeof part === 'object')
      return Object.entries(part).every(([key, child]) => !scanPrivateName(key) && safe(child));
    return true;
  };
  return safe;
}

/** Values which would disclose a capability, contact or denied input are never display data. */
export function scanValueSafe(found: Found, value: unknown, actor?: ScanActor): boolean {
  return safeValuePredicate(found, actor)(value);
}

/** Project the schema recursively rather than shipping a role-filtered top-level object unchanged. */
export function projectScanInputs(found: Found, actor: ScanActor): Personalization {
  const secrets = secretInputs(found.template.manifest);
  const active = found.activePolicy ?? found.activeTemplate ?? found.template;
  const activeSecrets = secretInputs(active.manifest);
  const safe = safeValuePredicate(found, actor);
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
    return value !== undefined && safe(value) ? (value as Json) : omitted;
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
    if (expr === undefined || value === null || !scanValueSafe(found, value, actor)) return null;
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
