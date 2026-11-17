import {
  hasContactShape,
  isPrivateName,
  leaksSecret,
} from '../../../passkit/template/scan-display/privacy.ts';
import {
  hiddenFieldKeys,
  type InputSchema,
  inputProps,
  inputVisibleTo,
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
import { passSecretSpellings } from './projection-privacy.ts';
import type { Found } from './resolve.ts';

const object = (value: unknown): Record<string, Json> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;

/** Collect nested, untyped and role-hidden input values before filtering the other scope roots. */
function inputForPreview(
  name: string,
  value: Json,
  schema: InputSchema | undefined,
  role: ScanRole,
  secrets: Set<string>,
  deniedKeys: Set<string>,
): Json | undefined {
  if (!schema || isPrivateName(name) || !inputVisibleTo(name, schema, role, secrets)) {
    deniedKeys.add(name);
    return undefined;
  }
  if (Array.isArray(value)) {
    const itemSchema = object(schema.items);
    return value.map(
      (entry) => inputForPreview(name, entry, itemSchema, role, secrets, deniedKeys) ?? null,
    );
  }
  const record = object(value);
  if (!record) return value;
  const properties = object(schema.properties);
  const result: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(record)) {
    const child = inputForPreview(key, entry, object(properties?.[key]), role, secrets, deniedKeys);
    if (child !== undefined) result[key] = child;
  }
  return result;
}

/** An expression left in a value, an address or a link is not display text. */
const contactOrExpression = (value: string): boolean =>
  value.includes('{{') || hasContactShape(value);

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
      if (deniedKeys.has(key) || isPrivateName(key)) return true;
    }
  }
  return false;
}

/**
 * Scope data has not gone through the renderer's text safety boundary. Omit unsafe leaves and
 * keys rather than returning template expressions or copies of protected values through a title,
 * field, lookup or nested object. Preserve array indices for bindings.
 */
function clean(
  value: Json | undefined,
  secrets: readonly string[],
  deniedKeys: Set<string>,
): Json | undefined {
  if (typeof value === 'string') {
    if (contactOrExpression(value) || leaksSecret(value, secrets)) return undefined;
    return value;
  }
  if (typeof value === 'number') return leaksSecret(value, secrets) ? undefined : value;
  if (value === null || typeof value === 'boolean' || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => clean(entry, secrets, deniedKeys) ?? null);
  const result: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPrivateName(key) || deniedKeys.has(key) || contactOrExpression(key)) continue;
    if (leaksSecret(key, secrets)) continue;
    const safe = clean(entry, secrets, deniedKeys);
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
  for (const { props, secrets } of policies) {
    for (const [name, schema] of Object.entries(props)) {
      if (isPrivateName(name) || !inputVisibleTo(name, schema, role, secrets)) deniedKeys.add(name);
    }
    for (const name of Object.keys(found.pass.personalization))
      if (!Object.hasOwn(props, name)) deniedKeys.add(name);
  }
  for (const [name, value] of Object.entries(found.pass.personalization)) {
    let safe: Json | undefined = value;
    for (const { props, secrets } of policies) {
      if (safe === undefined) break;
      safe = inputForPreview(name, safe, props[name], role, secrets, deniedKeys);
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
    if (hidden.has(field.key) || isPrivateName(field.key)) {
      deniedKeys.add(field.key);
    }
  }
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
  return (clean(scope as Json, passSecretSpellings(found), deniedKeys) ?? {}) as ScanDisplayScope;
}
