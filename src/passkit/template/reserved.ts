import type { TemplateManifest, ValidationIssue } from '../types.ts';
import { unknownCounterRefs } from './counters.ts';

/** Server values a template may read as `{{pass.<name>}}`. */
export const PASS_VALUES: readonly string[] = ['scanCode'];

/** Values that exist only when the manifest has the matching block. */
const BLOCK_VALUES = ['stamps', 'counters'] as const;

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
export function unknownPassValues(
  expr: string,
  manifest?: Pick<TemplateManifest, 'stamps' | 'counters'>,
): string[] {
  const blocks = BLOCK_VALUES.filter((name) => manifest?.[name] !== undefined) as string[];
  const unknown = [...expr.matchAll(/\bpass\.(\w+)/g)]
    .map((m) => m[1] ?? '')
    .filter((name) => !PASS_VALUES.includes(name) && !blocks.includes(name));
  const counters = manifest?.counters
    ? unknownCounterRefs(expr, { counters: manifest.counters })
    : [];
  return [...unknown, ...counters];
}
