/** `scanDisplayIssues` (C16, DM 6.2): size, shape, then the semantic rules, errors first. */
import type { z } from 'zod';
import type { PassJson, TemplateManifest, ValidationIssue } from '../../types.ts';
import { SCAN_DISPLAY_MAX_BYTES, ScanDisplayDocSchema } from './schema.ts';
import { hiddenFieldKeys, inputProps, secretInputs } from './scope.ts';
import { checkIds, checkStructure } from './validate-refs.ts';
import {
  buildFieldKeys,
  type Ctx,
  checkHolder,
  checkTexts,
  checkTitles,
  issueOf,
} from './validate-rules.ts';
import { walkDoc } from './walk.ts';

export interface ScanDisplayIssueOptions {
  passJson?: PassJson;
  assetNames?: string[];
}

const dotted = (path: PropertyKey[]) => path.map(String).join('.');

/** zod issues to DM 6.3 codes, each with its JSON path. */
export function shapeIssues(error: z.ZodError): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const raw of error.issues) {
    const last = raw.path.at(-1);
    let code = 'SHAPE';
    let path = dotted(raw.path);
    let message = 'This is not a valid scan screen.';
    if (raw.code === 'unrecognized_keys') {
      path = [path, raw.keys[0]].filter(Boolean).join('.');
      message = `Unknown key "${raw.keys[0]}".`;
    } else if (raw.path.length === 1 && last === 'v') {
      code = 'VERSION';
      message = 'Unknown scan screen version.';
    } else if (last === 'icon') {
      code = 'ICON';
      message = 'Pick an icon from the list.';
    } else if (last === 'tone') {
      code = 'TONE';
      message = 'Pick a tone from the list.';
    } else if (last === 'id') {
      code = 'ID';
      message = 'Ids use lowercase letters, digits and underscores, up to 24.';
    } else if (raw.code === 'too_big' && 'origin' in raw && raw.origin === 'string') {
      code = 'TEXT_LENGTH';
      message = 'This text is too long.';
    } else if (
      (raw.code === 'too_big' || raw.code === 'too_small') &&
      'origin' in raw &&
      raw.origin === 'array'
    ) {
      code = 'TOO_MANY';
      message = 'This list has the wrong number of items.';
    } else if (raw.code === 'custom' && /expression|interpolations/.test(raw.message)) {
      code = 'EXPR';
      message = raw.message;
    } else if (last === 'when' || (raw.code === 'invalid_union' && raw.path.includes('when'))) {
      code = 'CONDITION';
      message = 'This condition is not valid.';
    }
    const key = `${code}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issueOf('error', code, path, message));
  }
  return out;
}

export function scanDisplayIssues(
  manifest: TemplateManifest,
  options: ScanDisplayIssueOptions = {},
): ValidationIssue[] {
  const raw = manifest.scan?.display;
  if (raw === undefined) return [];
  if (new TextEncoder().encode(JSON.stringify(raw)).length > SCAN_DISPLAY_MAX_BYTES)
    return [issueOf('error', 'TOO_BIG', '', 'The scan screen is over 16 KB.')];
  const parsed = ScanDisplayDocSchema.safeParse(raw);
  if (!parsed.success) return shapeIssues(parsed.error);

  const doc = parsed.data;
  const issues: ValidationIssue[] = [];
  const actions = manifest.scan?.actions ?? [
    { id: 'check_in', label: 'Check in', kind: 'check_in' as const },
  ];
  const secrets = secretInputs(manifest);
  const ctx: Ctx = {
    manifest,
    doc,
    passJson: options.passJson,
    assetNames: options.assetNames,
    inputs: inputProps(manifest),
    secrets,
    hiddenFields: hiddenFieldKeys(manifest, options.passJson, secrets),
    fieldKeys: buildFieldKeys(options.passJson),
    actions,
    changed: new Set(
      actions
        .filter((a) => ['add', 'take', 'set'].includes(a.kind) && a.input)
        .map((a) => a.input as string),
    ),
    push: (severity, code, path, message) => issues.push(issueOf(severity, code, path, message)),
  };
  const slots = walkDoc(doc);
  checkIds(ctx);
  checkTexts(ctx, slots.texts, slots.exprs);
  checkHolder(ctx);
  checkTitles(ctx, slots.texts);
  checkStructure(ctx, slots, manifest.scan?.flags?.length ?? 0);
  return [
    ...issues.filter((i) => i.severity === 'error'),
    ...issues.filter((i) => i.severity !== 'error'),
  ];
}
