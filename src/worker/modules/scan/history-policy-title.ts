import { evaluate, exprReferences } from '../../../passkit/template/expr.ts';
import type { Personalization, TemplateManifest } from '../../../passkit/types.ts';
import type { HistoryManifest } from './history-policy.ts';

/** Derive a title from the selected current manifest and personalization, not a cached pass title. */
export function deriveCurrentHistoryTitle(
  template: HistoryManifest | null,
  raw: string | null,
): string | null {
  if (!template) return null;
  let value: Record<string, unknown> | null = null;
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      value =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      /* Invalid personalization. */
    }
  }
  const expression = template.manifest.display?.title;
  if (!value || expression === undefined) return null;
  try {
    // JSON.parse established an object whose descendants are JSON values.
    const currentInput = value as Personalization;
    const result = evaluate(expression, {
      input: currentInput,
      lookups: template.manifest.lookups ?? {},
    });
    return result === null || result === undefined || result === ''
      ? null
      : String(result).slice(0, 200);
  } catch {
    return null;
  }
}

export function historyTitleVisible(
  title: string | null,
  titleCommitted: boolean,
  currentTitle: string | null,
  titleSafety: { valueSafe(value: unknown): boolean; inputVisible(path: string): boolean } | null,
  currentPinned: HistoryManifest,
  current: Record<string, unknown>,
  titlePolicies: { manifest: TemplateManifest }[],
): boolean {
  try {
    if (
      title === null ||
      !titleCommitted ||
      title !== currentTitle ||
      !titleSafety ||
      !titleSafety.valueSafe(title)
    )
      return false;
    const expression = currentPinned.manifest.display?.title;
    if (expression === undefined) return false;
    // JSON.parse has already established an object; its descendants are JSON values.
    const currentInput = current as Personalization;
    const calculated = evaluate(expression, {
      input: currentInput,
      lookups: currentPinned.manifest.lookups ?? {},
    });
    if (
      calculated === null ||
      calculated === undefined ||
      calculated === '' ||
      String(calculated).slice(0, 200) !== title
    )
      return false;
    return titlePolicies.every(({ manifest }) => {
      const expression = manifest.display?.title;
      if (
        expression === undefined ||
        (typeof expression === 'string' && /\{\{\s*pass(?:[.\s|}]|\[|$)/.test(expression))
      )
        return false;
      return exprReferences(expression).inputs.every(titleSafety.inputVisible);
    });
  } catch {
    return false;
  }
}
