import {
  hiddenFieldKeys,
  type InputSchema,
  inputProps,
  inputVisibleTo,
  nameSegments,
  passFields,
  secretInputs,
} from '../../../passkit/template/scan-display/scope.ts';
import {
  parseParts,
  pathTokens,
  type ScanDisplayScope,
} from '../../../passkit/template/scan-display/text.ts';
import type { Json, ScanRole } from '../../../passkit/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scopeOf } from './card-projection.ts';
import { safeJson, sourcePolicyProven, visibleIdentity } from './card-semantics.ts';
import type { BuildDisplayInput } from './display.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { Found } from './resolve.ts';

const PRIVATE_SEGMENTS: Record<string, true> = {
  email: true,
  phone: true,
  tel: true,
  mobile: true,
  password: true,
  passcode: true,
  secret: true,
  token: true,
  pin: true,
  private: true,
  credential: true,
  authorization: true,
  cookie: true,
};
const PRIVATE_KEYS: Record<string, true> = {
  barcode: true,
  apikey: true,
  barcodes: true,
  scancode: true,
  serial: true,
  serialnumber: true,
  webserviceurl: true,
  messageencoding: true,
};

/** Even explicitly annotated contacts and secrets must not leave this preview API. */
function privateKey(key: string): boolean {
  return (
    Object.hasOwn(PRIVATE_KEYS, key.replace(/[^a-z0-9]/gi, '').toLowerCase()) ||
    nameSegments(key).some((part) => Object.hasOwn(PRIVATE_SEGMENTS, part))
  );
}

const object = (value: unknown): Record<string, Json> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;

function remember(value: unknown, denied: Set<string>): void {
  if (typeof value === 'string' && value !== '') {
    denied.add(value);
    // Pass bindings can transform the same protected value before it appears in a field.
    if (/[&<>"']/.test(value))
      denied.add(
        value
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;'),
      );
    if (/[^A-Za-z0-9_.!~*'()-]/.test(value)) denied.add(encodeURIComponent(value.toWellFormed()));
  } else if (typeof value === 'number' && Number.isFinite(value)) denied.add(String(value));
  else if (Array.isArray(value)) for (const entry of value) remember(entry, denied);
  else {
    const record = object(value);
    if (record) for (const entry of Object.values(record)) remember(entry, denied);
  }
}

/** Collect nested, untyped and role-hidden input values before filtering the other scope roots. */
function inputForPreview(
  name: string,
  value: Json,
  schema: InputSchema | undefined,
  role: ScanRole,
  secrets: Set<string>,
  deniedValues: Set<string>,
  deniedKeys: Set<string>,
): Json | undefined {
  if (!schema || privateKey(name) || !inputVisibleTo(name, schema, role, secrets)) {
    deniedKeys.add(name);
    remember(value, deniedValues);
    return undefined;
  }
  if (Array.isArray(value)) {
    const itemSchema = object(schema.items);
    return value.map(
      (entry) =>
        inputForPreview(name, entry, itemSchema, role, secrets, deniedValues, deniedKeys) ?? null,
    );
  }
  const record = object(value);
  if (!record) return value;
  const properties = object(schema.properties);
  const result: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(record)) {
    const child = inputForPreview(
      key,
      entry,
      object(properties?.[key]),
      role,
      secrets,
      deniedValues,
      deniedKeys,
    );
    if (child !== undefined) result[key] = child;
  }
  return result;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/iu;
const PHONE = /(?:^|[^A-Za-z0-9])\+?\d[\d ().-]*\d(?=$|[^A-Za-z0-9])/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}.*)?$/;

function contactOrExpression(value: string): boolean {
  if (value.includes('{{') || EMAIL.test(value) || /\b(?:https?:\/\/|mailto:|tel:)/i.test(value))
    return true;
  if (ISO_DATE.test(value)) return false;
  for (const match of value.matchAll(PHONE))
    if ((match[0].match(/\d/g) ?? []).length >= 7) return true;
  return false;
}

/** The projection and pass fields can themselves be derived from a protected path. */
function privateExpression(value: unknown, deniedKeys: Set<string>): boolean {
  if (typeof value !== 'string') return false;
  const { parts } = parseParts(value);
  if (!parts) return true;
  for (const part of parts) {
    if (!part.path) continue;
    const tokens = pathTokens(part.path);
    if (!tokens || tokens[0] === 'pass') return true;
    for (const token of tokens) {
      const key = token.startsWith('[') ? token.slice(1, -1).trim() : token;
      if (deniedKeys.has(key) || privateKey(key)) return true;
    }
  }
  return false;
}

function containsDenied(value: string, deniedValues: Set<string>): boolean {
  for (const denied of deniedValues)
    if (value === denied || (denied.length >= 3 && value.includes(denied))) return true;
  return false;
}

/**
 * Scope data has not gone through the renderer's text safety boundary. Omit unsafe leaves and
 * keys rather than returning template expressions or copies of protected values through a title,
 * field, lookup or nested object. Preserve array indices for bindings.
 */
function clean(
  value: Json | undefined,
  deniedValues: Set<string>,
  deniedKeys: Set<string>,
): Json | undefined {
  if (typeof value === 'string') {
    if (contactOrExpression(value) || containsDenied(value, deniedValues)) return undefined;
    return value;
  }
  if (typeof value === 'number') return deniedValues.has(String(value)) ? undefined : value;
  if (value === null || typeof value === 'boolean' || value === undefined) return value;
  if (Array.isArray(value))
    return value.map((entry) => clean(entry, deniedValues, deniedKeys) ?? null);
  const result: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (privateKey(key) || deniedKeys.has(key) || contactOrExpression(key)) continue;
    // Lookup keys can themselves be protected input values.
    if (containsDenied(key, deniedValues)) continue;
    const safe = clean(entry, deniedValues, deniedKeys);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

/** A safe, role-filtered copy of the scanner's actual pre-render scope for a client-side draft. */
export function previewScope(
  ctx: ServiceContext,
  input: BuildDisplayInput,
  found: Found,
): ScanDisplayScope {
  const role = input.actor.role;
  const active = found.activePolicy;
  if (
    !role ||
    !active ||
    input.pass?.id !== found.pass.id ||
    found.transferPending !== false ||
    !sourcePolicyProven(found, input.actor)
  )
    return {};
  const pinned = found.template.manifest;
  const manifests = active.manifest === pinned ? [pinned] : [pinned, active.manifest];
  const policies = manifests.map((manifest) => ({
    manifest,
    props: inputProps(manifest),
    secrets: secretInputs(manifest),
  }));
  const deniedKeys = new Set<string>();
  const deniedValues = new Set<string>();
  for (const { props, secrets } of policies) {
    for (const [name, schema] of Object.entries(props)) {
      if (privateKey(name) || !inputVisibleTo(name, schema, role, secrets)) deniedKeys.add(name);
    }
    for (const name of Object.keys(found.pass.personalization))
      if (!Object.hasOwn(props, name)) deniedKeys.add(name);
  }
  for (const [name, value] of Object.entries(found.pass.personalization)) {
    let safe: Json | undefined = value;
    for (const { props, secrets } of policies) {
      if (safe === undefined) break;
      safe = inputForPreview(name, safe, props[name], role, secrets, deniedValues, deniedKeys);
    }
  }

  const hidden = new Set<string>();
  for (const { manifest, secrets } of policies) {
    for (const key of hiddenFieldKeys(
      manifest,
      found.passJson,
      new Set([...secrets, ...deniedKeys]),
    ))
      hidden.add(key);
    for (const binding of manifest.bindings) {
      const to = binding.to;
      if (
        'field' in to &&
        (to.prop === undefined || to.prop === 'value') &&
        privateExpression(binding.value, deniedKeys)
      ) {
        for (const key of Array.isArray(to.field) ? to.field : [to.field]) hidden.add(key);
      }
    }
  }
  for (const field of passFields(found.passJson)) {
    if (hidden.has(field.key) || privateKey(field.key)) {
      deniedKeys.add(field.key);
      remember(field.value, deniedValues);
    }
  }
  const { pass, passJson } = found;
  for (const value of [
    pass.serial,
    pass.scanCode,
    pass.authToken,
    pass.downloadToken,
    pass.webServiceUrl,
    pass.holderEmail,
    passJson.serialNumber,
    passJson.authenticationToken,
    passJson.webServiceURL,
    passJson.barcode?.message,
    passJson.barcode?.altText,
    ...(passJson.barcodes ?? []).flatMap((barcode) => [barcode.message, barcode.altText]),
    passJson.nfc?.message,
  ])
    remember(value, deniedValues);

  const privacy = cardPrivacy(found, input.actor);
  const scope = scopeOf(ctx, input, found);
  // Keep the canonical input projection. The editor uses the active template's lookups and
  // identity, but their values and sources must also satisfy the original pinned policy.
  scope.lookups = safeJson(found, input.actor, active.manifest.lookups ?? {}, privacy) ?? {};
  scope.templateVersion = safeJson(found, input.actor, String(active.version), privacy) ?? '';
  const identity = visibleIdentity(found, input.actor, privacy, 'active');
  const passScope = object(scope.pass);
  if (passScope) {
    passScope.templateName = safeJson(found, input.actor, active.manifest.name, privacy) ?? '';
    passScope.externalId = null;
    const title = safeJson(found, input.actor, identity.title, privacy);
    const subtitle = safeJson(found, input.actor, identity.subtitle, privacy);
    if (
      title === undefined ||
      title === null ||
      privateExpression(active.manifest.display.title, deniedKeys)
    )
      delete passScope.title;
    else passScope.title = title;
    if (
      subtitle === undefined ||
      subtitle === null ||
      privateExpression(active.manifest.display.subtitle, deniedKeys)
    )
      delete passScope.subtitle;
    else passScope.subtitle = subtitle;
  }
  return (clean(scope as Json, deniedValues, deniedKeys) ?? {}) as ScanDisplayScope;
}
