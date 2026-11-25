/** `walletsManifestIssues`: shape first (zod), then expressions, field keys and art files. */
import type { z } from 'zod';
import type {
  Expr,
  IssueParams,
  PassJson,
  TemplateManifest,
  ValidationIssue,
} from '../../types.ts';
import { checkExpr, exprReferences } from '../expr.ts';
import { BINDING_STYLE_GROUPS } from '../pointer.ts';
import { WALLET_ART, WALLET_TARGETS, WalletsManifestSchema } from './schema.ts';

export interface WalletsIssueOptions {
  passJson?: PassJson;
  /** Package file names. Without them art files are not looked up. */
  assetNames?: readonly string[];
}

const dotted = (path: readonly PropertyKey[]) => ['wallets', ...path.map(String)].join('.');

/** zod issues to `WALLETS_*` codes, each with its dotted path. One issue per code and path. */
export function walletsShapeIssues(error: z.ZodError): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const raw of error.issues) {
    let path = dotted(raw.path);
    let code = 'WALLETS_SHAPE';
    let message = 'This is not a valid wallets block.';
    if (raw.code === 'unrecognized_keys') {
      path = `${path}.${raw.keys[0]}`;
      code = 'WALLETS_UNKNOWN_KEY';
      message = `Unknown key "${raw.keys[0]}".`;
    } else if (raw.path.length === 1 && raw.path[0] === 'schema') {
      code = 'WALLETS_VERSION';
      message = 'wallets.schema must be 1.';
    } else if (raw.path[0] === 'roles') {
      code = 'WALLETS_ROLE';
      message =
        raw.code === 'invalid_key'
          ? 'Unknown role name.'
          : 'A role is { "field": key }, { "value": expression } or false.';
    } else if (raw.path.at(-1) === 'type' || raw.path.at(-1) === 'subType') {
      code = 'WALLETS_TYPE';
      message = `${String(raw.path.at(-1))} is not offered for this wallet.`;
    }
    if (seen.has(`${code}|${path}`)) continue;
    seen.add(`${code}|${path}`);
    out.push({ severity: 'error', code, message, path });
  }
  return out;
}

function fieldKeysOf(passJson: PassJson | undefined): Set<string> {
  const keys = new Set<string>();
  for (const style of BINDING_STYLE_GROUPS.styles) {
    const dict = passJson?.[style] as Record<string, unknown> | undefined;
    if (!dict || typeof dict !== 'object') continue;
    for (const group of BINDING_STYLE_GROUPS.groups) {
      const fields = dict[group];
      if (Array.isArray(fields))
        for (const f of fields) keys.add(String((f as { key?: string }).key));
    }
  }
  return keys;
}

/** Static checks for `manifest.wallets`. An absent block has no issues. */
export function walletsManifestIssues(
  manifest: TemplateManifest,
  options: WalletsIssueOptions = {},
): ValidationIssue[] {
  const raw: unknown = (manifest as { wallets?: unknown }).wallets;
  if (raw === undefined) return [];
  const parsed = WalletsManifestSchema.safeParse(raw);
  if (!parsed.success) return walletsShapeIssues(parsed.error);

  const issues: ValidationIssue[] = [];
  const add =
    (severity: ValidationIssue['severity']) =>
    (code: string, message: string, path: string, params?: IssueParams) =>
      issues.push({ severity, code, message, path, ...(params ? { params } : {}) });
  const error = add('error');
  const warn = add('warning');
  const wallets = parsed.data;
  const properties = (manifest.inputs?.properties ?? {}) as Record<string, unknown>;
  const lookups = new Set(Object.keys(manifest.lookups ?? {}));
  const fields = fieldKeysOf(options.passJson);

  const checkExprAt = (value: Expr, path: string) => {
    const problem = checkExpr(value);
    if (problem) {
      error('WALLETS_EXPR', problem, path);
      return;
    }
    const refs = exprReferences(value);
    for (const name of refs.inputs)
      if (!Object.hasOwn(properties, name))
        warn('WALLETS_INPUT', `Unknown input "${name}".`, path, { name });
    for (const name of refs.lookups)
      if (!lookups.has(name)) error('WALLETS_LOOKUP', `Unknown lookup table "${name}".`, path);
  };

  for (const [role, source] of Object.entries(wallets.roles ?? {})) {
    const path = `wallets.roles.${role}`;
    if (source === false || source === undefined) continue;
    if ('value' in source) checkExprAt(source.value, `${path}.value`);
    else if (options.passJson && !fields.has(source.field))
      warn('WALLETS_ROLE_FIELD', `No field with key "${source.field}".`, `${path}.field`, {
        name: source.field,
      });
  }
  if (wallets.google?.classKey !== undefined)
    checkExprAt(wallets.google.classKey, 'wallets.google.classKey');
  if (typeof wallets.google?.classKey === 'string') {
    const parts = wallets.google.classKey.split(/(\{\{[^}]*\}\})/);
    const slots = parts.flatMap((part, i) =>
      part.startsWith('{{')
        ? [{ url: /\|\s*url\s*\}\}$/.test(part), before: parts[i - 1] ?? '' }]
        : [],
    );
    // `|url` escapes every character but A-Z a-z 0-9 - _ . ! ~ * ' ( ); a joiner from that set can merge parts.
    const joined = slots.every(
      (slot, i) => slot.url && (i === 0 || /[^\w\-.!~*'()]/.test(slot.before)),
    );
    if (slots.length > 1 && !joined)
      warn(
        'WALLETS_CLASS_KEY',
        'Parts of the class key can run together: end each with |url and join them with | or a space.',
        'wallets.google.classKey',
      );
  }
  const keyed =
    typeof wallets.google?.classKey === 'string'
      ? /^\s*\{\{\s*([\w-]+)\s*\}\}\s*$/.exec(wallets.google.classKey)?.[1]
      : undefined;
  const keyType = keyed ? (properties[keyed] as { type?: unknown } | undefined)?.type : undefined;
  if (keyType === 'object' || keyType === 'array')
    error(
      'WALLETS_CLASS_KEY',
      'The class key is an object or list. Read a text or number input, or one field of it.',
      'wallets.google.classKey',
    );

  const referenced = new Set<string>();
  for (const name of WALLET_TARGETS) {
    for (const [slot, file] of Object.entries(wallets[name]?.images ?? {})) {
      const path = `wallets.${name}.images.${slot}`;
      referenced.add(file);
      if (!WALLET_ART.test(file) || !file.startsWith(`wallets/${name}/`))
        error('WALLETS_IMAGE', `Art for ${name} lives in wallets/${name}/ as a PNG.`, path);
      else if (options.assetNames && !options.assetNames.includes(file))
        error('WALLETS_IMAGE_MISSING', `No file ${file} in the package.`, path);
    }
  }
  for (const file of options.assetNames ?? [])
    if (file.startsWith('wallets/') && !referenced.has(file))
      warn('WALLETS_ART_UNUSED', `${file} is not used by any wallets.*.images entry.`, file, {
        name: file,
      });
  return issues;
}
