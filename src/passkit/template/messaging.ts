import type { Binding, Json, PassJson, TemplateManifest, ValidationIssue } from '../types.ts';
import { exprReferences } from './expr.ts';
import { BINDING_STYLE_GROUPS } from './pointer.ts';

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function targetOf(binding: Binding): Record<string, unknown> {
  return binding.to as unknown as Record<string, unknown>;
}

const MESSAGE_CHANGE = '%@';

/** `messaging.input` must exist and drive a back field that shows its new value as the message. */
export function messagingIssues(
  manifest: TemplateManifest,
  passJson?: PassJson,
): ValidationIssue[] {
  if (manifest.messaging === undefined) return [];
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string) =>
    issues.push({ severity: 'error', code, message, path: 'messaging' });
  const input = (manifest.messaging as { input?: unknown } | null)?.input;
  const properties = isRecord(manifest.inputs?.properties) ? manifest.inputs.properties : {};
  if (typeof input !== 'string' || !Object.hasOwn(properties, input)) {
    error('MESSAGING_INPUT', `messaging.input "${String(input)}" is not an input.`);
    return issues;
  }
  if (!passJson) return issues;
  const messageKeys = new Set<string>();
  for (const style of BINDING_STYLE_GROUPS.styles) {
    const dict = passJson[style];
    const back = isRecord(dict) ? (dict as Record<string, unknown>).backFields : undefined;
    if (Array.isArray(back))
      for (const f of back as { key?: unknown; changeMessage?: unknown }[])
        if (f.changeMessage === MESSAGE_CHANGE) messageKeys.add(String(f.key));
  }
  const bound = (manifest.bindings ?? []).some((binding) => {
    const to = targetOf(binding);
    if (!('field' in to) || 'prop' in to) return false;
    const keys = Array.isArray(to.field) ? (to.field as string[]) : [String(to.field)];
    return (
      keys.some((key) => messageKeys.has(key)) &&
      binding.value !== undefined &&
      exprReferences(binding.value).inputs.includes(input)
    );
  });
  if (!bound)
    error('MESSAGING_FIELD', `Bind "${input}" to a back field whose changeMessage is "%@".`);
  return issues;
}
