import { conditionInputs } from '../../../passkit/template/expr.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import { passFields } from '../../../passkit/template/scan-display/scope.ts';
import { parseParts, pathTokens } from '../../../passkit/template/scan-display/text.ts';
import type { Json } from '../../../passkit/types.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { privateKey, safeJson } from './card-semantics-privacy.ts';
import type { BuildDisplayInput } from './display.ts';
import { type CardPrivacy, cardPrivacy } from './dto-projection.ts';
import { eventSafeProjection } from './event-safe-projection.ts';
import type { ScanActor } from './guard.ts';
import { scanIdentity, scanInputVisible } from './projection-privacy.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import type { Found } from './resolve.ts';
import { isFinalizedDisplayHistory } from './scan-display-history.ts';

export { safeJson, safeTimestamp } from './card-semantics-privacy.ts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Both source policies must be for the evaluated pass, tenant and release. */
export function sourcePolicyProven(found: Found, actor: ScanActor): boolean {
  try {
    const active = found.activePolicy ?? found.activeTemplate ?? found.template;
    return (
      (actor.role === 'door' || actor.role === 'desk' || actor.role === 'manager') &&
      validCredentialKeysetCommitment(actor.credentialKeysetCommitment) &&
      validCredentialKeysetCommitment(found.credentialKeysetCommitment) &&
      actor.credentialKeysetCommitment === found.credentialKeysetCommitment &&
      found.pass.orgId === actor.orgId &&
      found.pass.mode === actor.mode &&
      found.template.id === found.pass.templateId &&
      found.template.version === found.pass.templateVersion &&
      (found.template.orgId === null || found.template.orgId === actor.orgId) &&
      !!found.activeVersion &&
      active.id === found.pass.templateId &&
      (active.orgId === null || active.orgId === actor.orgId) &&
      active.version === found.activeVersion
    );
  } catch {
    return false;
  }
}

/** A source must survive both the schema projection and the stronger card-value policy. */
export function visibleSource(
  found: Found,
  actor: ScanActor,
  input: string,
  privacy: CardPrivacy = cardPrivacy(found, actor),
): boolean {
  if (!sourcePolicyProven(found, actor)) return false;
  // Issuance stores raw input and a binding reads it after defaults; the x-scan policy and the
  // card-value policy (which denies every hidden default) still decide.
  const personalization = applyDefaults(found.template.manifest, found.pass.personalization);
  const resolved = { ...found, pass: { ...found.pass, personalization } };
  if (!scanInputVisible(resolved, actor, input)) return false;
  let value: unknown = personalization;
  for (const key of input.split('.')) {
    const object = record(value);
    if (privateKey(key) || !privacy.safe(key) || !Object.hasOwn(object, key)) return false;
    value = object[key];
  }
  const projected = safeJson(found, actor, value, privacy);
  return projected !== undefined && JSON.stringify(projected) === JSON.stringify(value);
}

/** Check sources before a lookup or transformation can hide a protected value. */
function visibleExpression(
  found: Found,
  actor: ScanActor,
  privacy: CardPrivacy,
  expression: unknown,
): boolean {
  if (expression === undefined) return true;
  if (typeof expression !== 'string') return privacy.valueSafe(expression);
  const parts = parseParts(expression).parts;
  if (!parts) return false;
  for (const part of parts) {
    if (part.literal !== undefined && !privacy.safe(part.literal)) return false;
    if (!part.path) continue;
    const tokens = pathTokens(part.path);
    if (!tokens?.length || tokens[0] === 'pass') return false;
    for (const token of tokens) {
      if (token.startsWith('[')) {
        const selector = token.slice(1, -1).trim();
        if (privateKey(selector) || !privacy.safe(selector)) return false;
        if (
          Object.hasOwn(found.pass.personalization, selector) &&
          !visibleSource(found, actor, selector, privacy)
        )
          return false;
      } else if (tokens[0] === 'lookups' && (privateKey(token) || !privacy.safe(token))) {
        return false;
      }
    }
    if (tokens[0] !== 'lookups') {
      const source = tokens.filter((token) => !token.startsWith('[')).join('.');
      if (!visibleSource(found, actor, source, privacy)) return false;
    }
  }
  return true;
}

/** Re-evaluate either proven identity while retaining both source policies. */
export function visibleIdentity(
  found: Found,
  actor: ScanActor,
  privacy: CardPrivacy = cardPrivacy(found, actor),
  source: 'pinned' | 'active' = 'pinned',
): { title: string | null; subtitle: string | null } {
  if (!sourcePolicyProven(found, actor)) return { title: null, subtitle: null };
  const selected =
    source === 'active'
      ? (found.activePolicy ?? found.activeTemplate ?? found.template)
      : found.template;
  // Only identity evaluation swaps the manifests: the pass and every proof use the original Found.
  const identityFound =
    selected === found.template
      ? found
      : { ...found, template: selected, activePolicy: found.template };
  const names = scanIdentity(identityFound, actor);
  const manifest = selected.manifest;
  return {
    title:
      visibleExpression(found, actor, privacy, manifest.display.title) && privacy.safe(names.title)
        ? names.title
        : null,
    subtitle:
      visibleExpression(found, actor, privacy, manifest.display.subtitle) &&
      privacy.safe(names.subtitle)
        ? names.subtitle
        : null,
  };
}

function fieldSourcesVisible(
  found: Found,
  actor: ScanActor,
  privacy: CardPrivacy,
  key: string,
): boolean {
  const active = found.activePolicy ?? found.activeTemplate ?? found.template;
  const manifests =
    active === found.template
      ? [found.template.manifest]
      : [found.template.manifest, active.manifest];
  for (const manifest of manifests)
    for (const binding of manifest.bindings) {
      if (!('field' in binding.to) || ![binding.to.field].flat().includes(key)) continue;
      const conditions = [binding.when, binding.remove].flatMap((condition) =>
        condition ? conditionInputs(condition) : [],
      );
      if (
        conditions.some((name) => !visibleSource(found, actor, name, privacy)) ||
        !visibleExpression(found, actor, privacy, binding.value)
      )
        return false;
    }
  return true;
}

export function visibleFields(found: Found, actor: ScanActor): Record<string, Json> {
  const privacy = cardPrivacy(found, actor);
  const fields: Record<string, Json> = {};
  for (const field of passFields(found.passJson)) {
    if (
      privacy.hidden.has(field.key) ||
      privateKey(field.key) ||
      !privacy.fieldVisible(field.key) ||
      !fieldSourcesVisible(found, actor, privacy, field.key) ||
      !privacy.safe(field.key)
    )
      continue;
    const value = safeJson(found, actor, field.value, privacy);
    if (value !== undefined) fields[field.key] = value;
  }
  return fields;
}

/** The current action must satisfy the same source and role policy as a signed event. */
export function visibleAction(
  found: Found,
  actor: ScanActor,
  action: ResolvedScanAction,
  privacy: CardPrivacy = cardPrivacy(found, actor),
): boolean {
  if (
    !actor.role ||
    !sourcePolicyProven(found, actor) ||
    (action.input && !visibleSource(found, actor, action.input, privacy))
  )
    return false;
  return eventSafeProjection(found, actor, action).roles[actor.role]?.action != null;
}

export const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const source = record(value);
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
};

/** History is usable only after its event proofs and final output fence were verified. */
export function visibleHistory(found: Found, actor: ScanActor, value: unknown): Json {
  if (!isFinalizedDisplayHistory(value, actor, found)) return {};
  const privacy = cardPrivacy(found, actor);
  const source = record(value.value);
  const list = record(source.list);
  const entries = (items: unknown, keys: readonly string[]) =>
    Array.isArray(items) ? items.map((entry) => pick(entry, keys)) : [];
  const byInput = (items: unknown, project: (entry: unknown) => unknown) =>
    Object.fromEntries(
      Object.entries(record(items))
        .filter(([key]) => visibleSource(found, actor, key, privacy))
        .map(([key, entry]) => [key, project(entry)]),
    );
  const history = pick(source, ['checkedInAt', 'inside']);
  for (const [key, keys] of [
    ['visits', ['today', 'week', 'month', 'year', 'total']],
    ['scans', ['today', 'total']],
    ['lastVisit', ['at', 'where']],
    ['lastScan', ['at', 'where', 'action']],
  ] as const) {
    if (Object.hasOwn(source, key))
      history[key] = source[key] === null ? null : pick(source[key], keys);
  }
  if (Object.hasOwn(source, 'list')) {
    const lists: Record<string, unknown> = {};
    for (const key of ['visits', 'scans'] as const)
      if (Object.hasOwn(list, key)) lists[key] = entries(list[key], ['at', 'where', 'label']);
    if (Object.hasOwn(list, 'value'))
      lists.value = byInput(list.value, (items) =>
        entries(items, ['at', 'where', 'label', 'amount', 'after']),
      );
    history.list = lists;
  }
  if (Object.hasOwn(source, 'ledger'))
    history.ledger = byInput(source.ledger, (entry) => {
      const ledger = record(entry);
      return {
        ...pick(ledger, ['month']),
        ...(Object.hasOwn(ledger, 'last')
          ? { last: ledger.last === null ? null : pick(ledger.last, ['at', 'amount']) }
          : {}),
      };
    });
  return safeJson(found, actor, history, privacy, true) ?? {};
}

/** Scan value fields are only meaningful for a source input visible to this actor. */
export function visibleScan(ctx: ServiceContext, input: BuildDisplayInput, found: Found): Json {
  const privacy = cardPrivacy(found, input.actor);
  const source = record(input.scan);
  const suppliedAction = record(source.action);
  const actionId = typeof suppliedAction.id === 'string' ? suppliedAction.id : null;
  const sourceInput = typeof source.input === 'string' ? source.input : undefined;
  const matches = actionId
    ? found.scan.actions.filter((item) => item.id === actionId)
    : source.action === undefined && sourceInput
      ? found.scan.actions.filter((item) => item.input === sourceInput)
      : [];
  const candidate = matches.length === 1 ? matches[0] : undefined;
  const action =
    candidate &&
    (!sourceInput || candidate.input === sourceInput) &&
    (suppliedAction.kind === undefined || suppliedAction.kind === candidate.kind) &&
    (suppliedAction.label === undefined || suppliedAction.label === candidate.label) &&
    visibleAction(found, input.actor, candidate, privacy)
      ? candidate
      : undefined;
  const valuesVisible = !!action?.input && visibleSource(found, input.actor, action.input, privacy);
  const scan = {
    outcome: input.screen,
    at: ctx.clock.now(),
    direction: found.admission?.state.direction ?? 'in',
    ...pick(source, ['outcome', 'reason', 'at', 'method', 'direction']),
    ...(source.action && action
      ? { action: { id: action.id, label: action.label, kind: action.kind } }
      : {}),
    // A previous scanner name is historical metadata, not an authenticated current value.
    ...(source.previous ? { previous: pick(source.previous, ['at']) } : {}),
    ...(valuesVisible
      ? { input: action.input, ...pick(source, ['amount', 'before', 'after']) }
      : {}),
  };
  // These are generic system state, not values derived from the pass. In particular an exit
  // must remain an exit even if an unrelated hidden input happens to contain the word "out".
  const direction =
    source.direction === 'in' || source.direction === 'out'
      ? source.direction
      : (found.admission?.state.direction ?? 'in');
  return {
    ...(record(safeJson(found, input.actor, scan, privacy, true)) as Record<string, Json>),
    outcome: input.screen,
    direction,
  };
}
