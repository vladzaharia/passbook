import type { Binding, Json, PassField, PassJson, Personalization } from '../types.ts';
import { type ExprScope, evaluate, isEmpty, type PassScope, testCondition } from './expr.ts';
import { applyDefaults } from './manifest.ts';
import { BINDING_STYLE_GROUPS, deletePointer, isAllowedPointer, setPointer } from './pointer.ts';
import type { ResolvedTemplate } from './registry.ts';

type Dict = Record<string, unknown>;

export function styleDicts(pass: PassJson): Dict[] {
  return BINDING_STYLE_GROUPS.styles
    .map((style) => pass[style] as Dict | undefined)
    .filter((dict): dict is Dict => typeof dict === 'object' && dict !== null);
}

export function allFields(pass: PassJson): PassField[] {
  const out: PassField[] = [];
  for (const dict of styleDicts(pass))
    for (const group of BINDING_STYLE_GROUPS.groups) {
      const fields = dict[group];
      if (Array.isArray(fields)) out.push(...(fields as PassField[]));
    }
  return out;
}

function removeFields(pass: PassJson, keys: string[]): void {
  for (const dict of styleDicts(pass))
    for (const group of BINDING_STYLE_GROUPS.groups) {
      const fields = dict[group];
      if (Array.isArray(fields))
        dict[group] = (fields as PassField[]).filter((f) => !keys.includes(f.key));
    }
}

export interface BoundPass {
  pass: PassJson;
  /** Image slots (`thumbnail`, `strip`) whose files must not ship for this pass. */
  droppedImages: string[];
}

interface Context {
  pass: PassJson;
  scope: ExprScope;
  dropped: Set<string>;
}

function applyField(
  ctx: Context,
  binding: Binding,
  to: { field: string | string[]; prop?: string },
): void {
  const keys = Array.isArray(to.field) ? to.field : [to.field];
  const prop = to.prop ?? 'value';
  if (binding.remove && testCondition(binding.remove, ctx.scope)) {
    removeFields(ctx.pass, keys);
    return;
  }
  if (binding.value === undefined) return;
  const value = evaluate(binding.value, ctx.scope);
  const targets = allFields(ctx.pass).filter((f) => keys.includes(f.key));
  if (binding.omitIfEmpty && isEmpty(value)) {
    if (prop === 'value') removeFields(ctx.pass, keys);
    else for (const f of targets) delete (f as Dict)[prop];
    return;
  }
  for (const f of targets) {
    if (value === undefined) {
      if (prop === 'value') f.value = '';
      else delete (f as Dict)[prop];
    } else (f as Dict)[prop] = value;
  }
}

function applyAction(ctx: Context, binding: Binding, to: { action: string; prop: string }): void {
  const actions = (ctx.pass.featuredActions ?? []) as Json[];
  const action = actions.find((a) => (a as Dict | null)?.identifier === to.action) as
    | Record<string, Json | undefined>
    | undefined;
  if (!action) return;
  const drop = () => {
    ctx.pass.featuredActions = actions.filter(
      (a) => a !== action,
    ) as typeof ctx.pass.featuredActions;
  };
  if (binding.remove && testCondition(binding.remove, ctx.scope)) {
    drop();
    return;
  }
  if (binding.value === undefined) return;
  const value = evaluate(binding.value, ctx.scope);
  if (value === undefined || (binding.omitIfEmpty && isEmpty(value))) {
    drop();
    return;
  }
  action[to.prop] = value;
}

function applyBarcode(
  ctx: Context,
  binding: Binding,
  to: { barcode: number | '*'; prop: string },
): void {
  const barcodes = ctx.pass.barcodes ?? [];
  const selected = barcodes.filter((_, i) => to.barcode === '*' || to.barcode === i);
  const drop = () => {
    ctx.pass.barcodes = barcodes.filter((b) => !selected.includes(b));
  };
  if (binding.remove && testCondition(binding.remove, ctx.scope)) {
    drop();
    return;
  }
  if (binding.value === undefined) return;
  const value = evaluate(binding.value, ctx.scope);
  if (binding.omitIfEmpty && isEmpty(value)) {
    drop();
    return;
  }
  for (const b of selected) (b as unknown as Dict)[to.prop] = value ?? '';
}

function applyPointer(ctx: Context, binding: Binding, to: { pointer: string }): void {
  const problem = isAllowedPointer(to.pointer);
  if (problem) throw new Error(problem);
  if (binding.remove && testCondition(binding.remove, ctx.scope)) {
    deletePointer(ctx.pass, to.pointer);
    return;
  }
  if (binding.value === undefined) return;
  const value = evaluate(binding.value, ctx.scope);
  if (value === undefined || (binding.omitIfEmpty && isEmpty(value))) {
    deletePointer(ctx.pass, to.pointer);
    return;
  }
  if (!setPointer(ctx.pass, to.pointer, value))
    throw new Error(`Cannot set ${to.pointer}: parent is missing or not a container.`);
}

function applyImage(ctx: Context, binding: Binding, to: { image: string }): void {
  if (binding.remove && testCondition(binding.remove, ctx.scope)) {
    ctx.dropped.add(to.image);
    return;
  }
  if (
    binding.value !== undefined &&
    binding.omitIfEmpty &&
    isEmpty(evaluate(binding.value, ctx.scope))
  )
    ctx.dropped.add(to.image);
}

function applyBinding(ctx: Context, binding: Binding): void {
  if (binding.when && !testCondition(binding.when, ctx.scope)) return;
  const to = binding.to as unknown as Dict;
  if ('field' in to) applyField(ctx, binding, to as never);
  else if ('action' in to) applyAction(ctx, binding, to as never);
  else if ('barcode' in to) applyBarcode(ctx, binding, to as never);
  else if ('pointer' in to) applyPointer(ctx, binding, to as never);
  else if ('image' in to) applyImage(ctx, binding, to as never);
}

/** Applies manifest bindings to a copy of the template's pass.json. */
export function bindPass(
  template: ResolvedTemplate,
  input: Personalization,
  server: PassScope = {},
): BoundPass {
  const pass = structuredClone(template.passJson);
  const scope: ExprScope = {
    input: applyDefaults(template.manifest, input),
    lookups: template.manifest.lookups ?? {},
    pass: server,
  };
  const ctx: Context = { pass, scope, dropped: new Set() };
  for (const binding of template.manifest.bindings) applyBinding(ctx, binding);
  return { pass, droppedImages: [...ctx.dropped].sort() };
}
