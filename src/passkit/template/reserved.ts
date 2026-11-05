import type { TemplateManifest, ValidationIssue } from '../types.ts';

/** Server values a template may read as `{{pass.<name>}}`. */
export const PASS_VALUES: readonly string[] = ['scanCode'];

/** `pass` names the server scope in expressions, so an input cannot use it. */
export function reservedInputIssues(manifest: TemplateManifest): ValidationIssue[] {
  const properties = manifest.inputs?.properties;
  if (!properties || typeof properties !== 'object' || !Object.hasOwn(properties, 'pass'))
    return [];
  return [
    {
      severity: 'error',
      code: 'INPUT_RESERVED',
      message: '"pass" is reserved for server values; rename the input.',
      path: 'inputs.properties.pass',
    },
  ];
}

/** The `pass.<name>` references in an expression that are not server values. */
export function unknownPassValues(expr: string): string[] {
  return [...expr.matchAll(/\bpass\.(\w+)/g)]
    .map((m) => m[1] ?? '')
    .filter((name) => !PASS_VALUES.includes(name));
}
