import type { PassJson, TemplateManifest, ValidationIssue } from '../types.ts';
import {
  actionIssues,
  isDateTime,
  isInt,
  isRecord,
  label,
  MAX_LABEL,
  propertiesOf,
  type Report,
  typeOf,
} from './scan-actions.ts';
import { scanDisplayIssues } from './scan-display/index.ts';

import { nfcIssues } from './scan-nfc.ts';

export { nfcIssues };

const SCAN_KEYS = new Set(['actions', 'lookup', 'window', 'flags', 'display', 'access']);
const WINDOW_KEYS = new Set(['from', 'until', 'earlyMinutes', 'lateMinutes']);
const MAX_FLAGS = 4;
const MAX_WINDOW_MINUTES = 1440;
const MAX_DISPLAY_BYTES = 16 * 1024;

/** Static checks for `manifest.scan` (SA 4.1). The display's own rules live in `scanDisplayIssues`. */
export function scanIssues(manifest: TemplateManifest): ValidationIssue[] {
  const scan = (manifest as { scan?: unknown }).scan;
  if (scan === undefined) return [];
  const issues: ValidationIssue[] = [];
  const add =
    (severity: ValidationIssue['severity']) => (code: string, message: string, path: string) =>
      issues.push({ severity, code, message, path });
  const error = add('error');
  const warn = add('warning');
  if (!isRecord(scan)) {
    error('SCAN_SHAPE', 'scan must be an object.', 'scan');
    return issues;
  }
  const properties = propertiesOf(manifest);
  const input = (name: unknown) =>
    typeof name === 'string' && Object.hasOwn(properties, name) ? properties[name] : undefined;

  for (const key of Object.keys(scan))
    if (!SCAN_KEYS.has(key))
      error('SCAN_SHAPE', `scan.${key} is not a scan setting.`, `scan.${key}`);

  actionIssues(scan.actions, { error, warn, input, manifest });

  if (scan.lookup !== undefined) {
    const lookup = scan.lookup;
    const schema = isRecord(lookup) ? input(lookup.input) : undefined;
    const type = typeOf(schema);
    if (type !== 'string' && type !== 'integer')
      error(
        'SCAN_LOOKUP_INPUT',
        'lookup.input must be a text or whole-number input.',
        'scan.lookup',
      );
  }

  if (scan.window !== undefined) {
    const w = scan.window;
    if (!isRecord(w)) error('SCAN_SHAPE', 'window must be an object.', 'scan.window');
    else {
      for (const key of Object.keys(w))
        if (!WINDOW_KEYS.has(key))
          error('SCAN_SHAPE', `window.${key} is not a window setting.`, `scan.window.${key}`);
      for (const key of ['from', 'until'] as const)
        if (w[key] !== undefined && !isDateTime(input(w[key])))
          error(
            'SCAN_WINDOW_INPUT',
            `window.${key} must be a date-time input.`,
            `scan.window.${key}`,
          );
      for (const key of ['earlyMinutes', 'lateMinutes'] as const)
        if (w[key] !== undefined && !(isInt(w[key]) && w[key] >= 0 && w[key] <= MAX_WINDOW_MINUTES))
          error(
            'SCAN_WAIT_RANGE',
            `window.${key} must be 0 to ${MAX_WINDOW_MINUTES}.`,
            `scan.window.${key}`,
          );
    }
  }

  if (scan.flags !== undefined) flagIssues(scan.flags, input, error);

  if (scan.display !== undefined) {
    const size = new TextEncoder().encode(JSON.stringify(scan.display) ?? '').length;
    if (size > MAX_DISPLAY_BYTES)
      error('SCAN_DISPLAY_TOO_BIG', 'The scan screen is larger than 16 KB.', 'scan.display');
  }
  return issues;
}

function flagIssues(flags: unknown, input: (n: unknown) => unknown, error: Report): void {
  if (!Array.isArray(flags)) {
    error('SCAN_FLAGS', 'flags must be a list.', 'scan.flags');
    return;
  }
  if (flags.length > MAX_FLAGS) error('SCAN_FLAGS', `At most ${MAX_FLAGS} flags.`, 'scan.flags');
  for (const [i, flag] of flags.entries()) {
    const path = `scan.flags.${i}`;
    if (!isRecord(flag)) {
      error('SCAN_FLAGS', 'A flag must be an object.', path);
      continue;
    }
    if (input(flag.input) === undefined)
      error('SCAN_FLAGS', `Flag input "${String(flag.input)}" is not an input.`, `${path}.input`);
    if (!label(flag.label))
      error('SCAN_FLAGS', `A flag label is 1 to ${MAX_LABEL} characters.`, `${path}.label`);
    if (
      flag.equals !== undefined &&
      !(Array.isArray(flag.equals) && flag.equals.every((v) => typeof v === 'string'))
    )
      error('SCAN_FLAGS', 'equals must be a list of text values.', `${path}.equals`);
    if (flag.stop !== undefined && typeof flag.stop !== 'boolean')
      error('SCAN_FLAGS', 'stop must be true or false.', `${path}.stop`);
  }
}

/** What both manifest validators add: `scan`, `nfc`, then the scan screen's own rules (C16). */
export function scanManifestIssues(
  manifest: TemplateManifest,
  options: { passJson?: PassJson; assetNames?: string[] } = {},
): ValidationIssue[] {
  const issues = [...scanIssues(manifest), ...nfcIssues(manifest, options.passJson)];
  if (isRecord((manifest as { scan?: unknown }).scan))
    issues.push(...scanDisplayIssues(manifest, options));
  return issues;
}
