import { DATE_STYLES, NUMBER_STYLES, TEXT_ALIGNMENTS } from '../../../passkit/schema/constants.ts';
import { conditionInputs } from '../../../passkit/template/expr.ts';
import { parsePointer } from '../../../passkit/template/pointer.ts';
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
  secretInputs,
} from '../../../passkit/template/scan-display/scope.ts';
import { parseParts, pathTokens } from '../../../passkit/template/scan-display/text.ts';
import type { Binding, TemplateManifest } from '../../../passkit/types.ts';
import type { ScanActor } from './guard.ts';
import { passSecretSpellings, scanInputVisible } from './projection-privacy.ts';
import type { Found } from './resolve.ts';

export const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/i;

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type Scalar = string | number | boolean | null;

export interface CardPrivacy {
  safe(value: unknown): value is Scalar;
  valueSafe(value: unknown): boolean;
  fieldVisible(key: string): boolean;
  fieldBindings(key: string): Binding[];
  pointerVisible(path: string[]): boolean;
  hidden: Set<string>;
}

/** Build one policy for both the miniature pass and the card's action values. */
export function cardPrivacy(found: Found, actor: ScanActor): CardPrivacy {
  const { pass, passJson, template } = found;
  const manifests = [template.manifest];
  const activePolicy = found.activePolicy ?? found.activeTemplate;
  if (activePolicy && activePolicy.manifest !== template.manifest)
    manifests.push(activePolicy.manifest);
  const policies = manifests.map((manifest) => ({
    manifest,
    props: inputProps(manifest),
    secrets: secretInputs(manifest),
  }));
  const role = actor.role ?? 'door';
  const deniedInputs = new Set<string>();
  const secrets = passSecretSpellings(found);

  const sourceAllowed = (name: string) =>
    actor.role !== null &&
    !isPrivateName(name) &&
    policies.every(({ props, secrets }) => {
      const schema = Object.hasOwn(props, name) ? props[name] : undefined;
      return schema !== undefined && inputVisibleTo(name, schema, role, secrets);
    });
  const rootVisible = (name: string) => {
    if (!sourceAllowed(name)) return false;
    if (Object.hasOwn(pass.personalization, name)) return scanInputVisible(found, actor, name);
    const schema = policies[0]?.props[name];
    return schema !== undefined && Object.hasOwn(schema, 'default') && safe(schema.default);
  };
  for (const { props } of policies)
    for (const name of Object.keys(props)) if (!sourceAllowed(name)) deniedInputs.add(name);
  for (const name of Object.keys(pass.personalization))
    if (!sourceAllowed(name)) deniedInputs.add(name);

  const safe = (value: unknown): value is Scalar => {
    if (typeof value === 'string')
      return !value.includes('{{') && !hasContactShape(value) && !leaksSecret(value, secrets);
    if (typeof value === 'number') return Number.isFinite(value) && !leaksSecret(value, secrets);
    return typeof value === 'boolean' || value === null;
  };
  const valueSafe = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(valueSafe);
    const object = record(value);
    if (object)
      return Object.entries(object).every(
        ([key, child]) => !isPrivateName(key) && safe(key) && valueSafe(child),
      );
    return safe(value);
  };

  const pathVisible = (path: string, manifest: TemplateManifest, collections: boolean): boolean => {
    const tokens = pathTokens(path);
    if (
      !tokens?.[0] ||
      tokens[0] === 'pass' ||
      ['__proto__', 'constructor', 'prototype'].includes(tokens[0])
    )
      return false;
    const [root, ...rest] = tokens as [string, ...string[]];
    const schemas = policies.map(({ props }) => props[root]);
    const defaulted = root !== 'lookups' && !Object.hasOwn(pass.personalization, root);
    let value: unknown =
      root === 'lookups'
        ? manifest.lookups
        : defaulted
          ? policies[0]?.props[root]?.default
          : pass.personalization[root];
    if (root !== 'lookups' && !sourceAllowed(root)) return false;
    let inputPath = root;
    for (const token of rest) {
      let key = token;
      if (token.startsWith('[')) {
        key = token.slice(1, -1).trim();
        const selectorSchema = policies[0]?.props[key];
        const hasDefault = selectorSchema && Object.hasOwn(selectorSchema, 'default');
        if (Object.hasOwn(pass.personalization, key) || hasDefault) {
          if (!rootVisible(key)) return false;
          const index = Object.hasOwn(pass.personalization, key)
            ? pass.personalization[key]
            : selectorSchema?.default;
          if (typeof index !== 'string' && typeof index !== 'number') return false;
          key = String(index);
        }
      }
      inputPath += `.${key}`;
      if (isPrivateName(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
        return false;
      if (root !== 'lookups') {
        for (const [index, policy] of policies.entries()) {
          const schema = schemas[index];
          const next = Array.isArray(value)
            ? record(schema?.items)
            : record(record(schema?.properties)?.[key]);
          const child = next as InputSchema | undefined;
          if (!child || !inputVisibleTo(key, child, role, policy.secrets)) return false;
          schemas[index] = child;
        }
      }
      value = Array.isArray(value) ? value[Number(key)] : record(value)?.[key];
    }
    return (
      (collections || value === null || typeof value !== 'object') &&
      (root === 'lookups' ||
        (defaulted
          ? value !== undefined && (collections ? valueSafe(value) : safe(value))
          : scanInputVisible(found, actor, inputPath)))
    );
  };
  const bindingVisible = (
    binding: Binding,
    manifest: TemplateManifest,
    collections = false,
  ): boolean => {
    for (const condition of [binding.when, binding.remove])
      if (condition && conditionInputs(condition).some((name) => !rootVisible(name))) return false;
    if (typeof binding.value !== 'string') return true;
    const { parts } = parseParts(binding.value);
    return (
      !!parts && parts.every((part) => !part.path || pathVisible(part.path, manifest, collections))
    );
  };
  const bindingsFor = (manifest: TemplateManifest, key: string) =>
    manifest.bindings.filter(
      (binding) => 'field' in binding.to && [binding.to.field].flat().includes(key),
    );
  const fieldBindings = (key: string) => bindingsFor(template.manifest, key);
  const fieldVisible = (key: string) =>
    manifests.every((manifest) =>
      bindingsFor(manifest, key).every((binding) => bindingVisible(binding, manifest)),
    );
  const pointerVisible = (path: string[]) =>
    manifests.every((manifest) =>
      manifest.bindings.every((binding) => {
        if (!('pointer' in binding.to)) return true;
        const target = parsePointer(binding.to.pointer);
        if (!target) return false;
        const overlaps =
          target.every((part, index) => path[index] === part) ||
          path.every((part, index) => target[index] === part);
        return !overlaps || bindingVisible(binding, manifest, true);
      }),
    );
  const hidden = new Set<string>();
  for (const { manifest } of policies)
    for (const key of hiddenFieldKeys(manifest, passJson, deniedInputs)) hidden.add(key);
  return { safe, valueSafe, fieldVisible, fieldBindings, pointerVisible, hidden };
}

export function fieldPropertyAllowed(key: string, value: unknown): boolean {
  if (key === 'dateStyle' || key === 'timeStyle')
    return typeof value === 'string' && (DATE_STYLES as readonly string[]).includes(value);
  if (key === 'numberStyle')
    return typeof value === 'string' && (NUMBER_STYLES as readonly string[]).includes(value);
  if (key === 'textAlignment')
    return typeof value === 'string' && (TEXT_ALIGNMENTS as readonly string[]).includes(value);
  if (key === 'currencyCode') return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
  if (key === 'isRelative' || key === 'ignoresTimeZone') return typeof value === 'boolean';
  if (key === 'row') return value === 0 || value === 1;
  return key === 'value' || (key === 'label' && typeof value === 'string');
}

export const FIELD_PROPERTIES = [
  'value',
  'label',
  'dateStyle',
  'timeStyle',
  'numberStyle',
  'textAlignment',
  'currencyCode',
  'isRelative',
  'ignoresTimeZone',
  'row',
] as const;
