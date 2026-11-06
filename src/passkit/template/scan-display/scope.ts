/**
 * What a binding may read (DM 3.1, 1.11 rules 7 and 8): the secret rules, `x-scan` visibility, the
 * binding catalogue for the editor, and the goals a `progress` row takes from `take` actions.
 * The server builds the scope with these; the renderer never sees a secret.
 */
import type { Json, PassJson, ScanRole, TemplateManifest } from '../../types.ts';
import { PASS_STYLES } from '../../types.ts';
import { exprReferences } from '../expr.ts';

export const ROLE_RANK: Record<ScanRole, number> = { door: 0, desk: 1, manager: 2 };
export const roleAtLeast = (role: ScanRole, needed: ScanRole | undefined): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[needed ?? 'door'];

export type InputSchema = Record<string, Json>;

export function inputProps(
  manifest: Pick<TemplateManifest, 'inputs'>,
): Record<string, InputSchema> {
  const props = manifest.inputs?.properties ?? {};
  const out: Record<string, InputSchema> = {};
  for (const [name, schema] of Object.entries(props))
    out[name] = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
  return out;
}

/** Name segments, camelCase or snake_case: `wifiPassword` is `wifi`, `password`. */
export const nameSegments = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());

const SECRET_SEGMENTS = new Set([
  'email',
  'phone',
  'tel',
  'mobile',
  'password',
  'passcode',
  'secret',
  'token',
  'pin',
]);

/** Secret whatever the author says: contact formats and widgets. */
export function isFormatSecret(schema: InputSchema): boolean {
  const widget = schema['x-widget'];
  return (
    schema.format === 'email' ||
    schema.format === 'uri' ||
    widget === 'email' ||
    widget === 'tel' ||
    widget === 'url'
  );
}

export type ScanLevel = ScanRole | 'hidden';
export function scanLevel(schema: InputSchema): ScanLevel {
  const value = schema['x-scan'];
  return value === 'desk' || value === 'manager' || value === 'hidden' ? value : 'door';
}

/** Secret by name, until the author sets `x-scan` on purpose. */
export const isNameSecret = (name: string, schema: InputSchema): boolean =>
  schema['x-scan'] === undefined && nameSegments(name).some((s) => SECRET_SEGMENTS.has(s));

export const isSecretInput = (name: string, schema: InputSchema): boolean =>
  isFormatSecret(schema) || isNameSecret(name, schema);

/** Inputs bound only to a barcode message are secrets too: the message opens the pass. */
export function barcodeOnlyInputs(manifest: Pick<TemplateManifest, 'bindings'>): Set<string> {
  const barcode = new Set<string>();
  const other = new Set<string>();
  for (const binding of manifest.bindings ?? []) {
    if (binding.value === undefined) continue;
    const names = exprReferences(binding.value).inputs;
    const target = 'barcode' in binding.to && binding.to.prop === 'message' ? barcode : other;
    for (const name of names) target.add(name);
  }
  return new Set([...barcode].filter((name) => !other.has(name)));
}

/** Every input no role may read, as the server and the validator agree. */
export function secretInputs(manifest: Pick<TemplateManifest, 'inputs' | 'bindings'>): Set<string> {
  const out = barcodeOnlyInputs(manifest);
  for (const [name, schema] of Object.entries(inputProps(manifest)))
    if (isSecretInput(name, schema)) out.add(name);
  return out;
}

export function inputVisibleTo(
  name: string,
  schema: InputSchema,
  role: ScanRole,
  secrets?: Set<string>,
): boolean {
  if (secrets?.has(name) || isSecretInput(name, schema)) return false;
  const level = scanLevel(schema);
  return level !== 'hidden' && roleAtLeast(role, level);
}

export interface PassFieldRef {
  key: string;
  value: unknown;
}

/** The pass's front and back fields, flat. */
export function passFields(passJson: PassJson | undefined): PassFieldRef[] {
  if (!passJson) return [];
  const out: PassFieldRef[] = [];
  for (const style of PASS_STYLES) {
    const block = (passJson as Record<string, unknown>)[style];
    if (!block || typeof block !== 'object') continue;
    for (const group of Object.values(block as Record<string, unknown>))
      if (Array.isArray(group))
        for (const field of group as { key?: string; value?: unknown }[])
          if (field && typeof field.key === 'string')
            out.push({ key: field.key, value: field.value });
  }
  return out;
}

const PASS_BINDING = /\{\{\s*pass[.[\]|}\s]/;

/** Fields whose value reads a secret input or `pass.*`, or shows the barcode message. */
export function hiddenFieldKeys(
  manifest: Pick<TemplateManifest, 'inputs' | 'bindings'>,
  passJson?: PassJson,
  secrets: Set<string> = secretInputs(manifest),
): Set<string> {
  const hidden = new Set<string>();
  for (const binding of manifest.bindings ?? []) {
    const to = binding.to;
    if (!('field' in to) || (to.prop !== undefined && to.prop !== 'value')) continue;
    const expr = binding.value;
    if (typeof expr !== 'string') continue;
    const reads = exprReferences(expr).inputs;
    if (!PASS_BINDING.test(expr) && !reads.some((name) => secrets.has(name))) continue;
    for (const key of Array.isArray(to.field) ? to.field : [to.field]) hidden.add(key);
  }
  const messages = new Set(
    (passJson?.barcodes ?? []).map((b) => String((b as { message?: unknown }).message ?? '')),
  );
  for (const field of passFields(passJson))
    if (typeof field.value === 'string' && field.value !== '' && messages.has(field.value))
      hidden.add(field.key);
  return hidden;
}

/** Take actions give a `progress` row its goal and reward label, by input. */
export function actionGoals(
  manifest: Pick<TemplateManifest, 'scan'>,
): Record<string, { goal: number; reward?: string }> {
  const out: Record<string, { goal: number; reward?: string }> = {};
  for (const action of manifest.scan?.actions ?? []) {
    if (action.kind !== 'take' || !action.input) continue;
    const goal =
      typeof action.amount === 'number'
        ? action.amount
        : (action.amount?.default ?? action.amount?.max ?? 1);
    if (!(action.input in out))
      out[action.input] = action.rewardLabel ? { goal, reward: action.rewardLabel } : { goal };
  }
  return out;
}

/** Pass keys a display may read, by who may read them. */
export const PASS_KEYS: { key: string; role: ScanRole }[] = [
  { key: 'title', role: 'door' },
  { key: 'subtitle', role: 'door' },
  { key: 'status', role: 'door' },
  { key: 'statusLabel', role: 'door' },
  { key: 'validFrom', role: 'door' },
  { key: 'validUntil', role: 'door' },
  { key: 'createdAt', role: 'door' },
  { key: 'version', role: 'door' },
  { key: 'templateName', role: 'door' },
  { key: 'style', role: 'door' },
  { key: 'externalId', role: 'desk' },
];

/** Pass keys that are secrets: `pass.<key>` is `SCAN_DISPLAY_SECRET`. */
export const SECRET_PASS_KEYS = new Set([
  'scanCode',
  'authenticationToken',
  'webServiceURL',
  'serial',
  'serialNumber',
  'downloadToken',
  'barcode',
  'barcodes',
  'message',
]);

const SCAN_KEYS = [
  'outcome',
  'reason',
  'at',
  'method',
  'action.id',
  'action.label',
  'action.kind',
  'amount',
  'before',
  'after',
  'direction',
  'previous.at',
  'previous.where',
];
const HISTORY_KEYS = [
  'lastVisit.at',
  'lastVisit.where',
  'visits.today',
  'visits.week',
  'visits.month',
  'visits.year',
  'visits.total',
  'checkedInAt',
  'inside',
  'scans.today',
  'scans.total',
  'lastScan.at',
  'lastScan.where',
  'lastScan.action',
];
const EVENT_KEYS = ['name', 'opensAt', 'closesAt', 'arrived', 'expected', 'capacity'];

/** The paths a role may bind, for the editor's picker. Secrets are not listed: no role reads them. */
export function scopeCatalog(manifest: TemplateManifest, role: ScanRole): string[] {
  const secrets = secretInputs(manifest);
  const paths = ['holder.name', 'holder.firstName', 'holder.initials'];
  for (const [name, schema] of Object.entries(inputProps(manifest)))
    if (inputVisibleTo(name, schema, role, secrets)) paths.push(`inputs.${name}`);
  for (const { key, role: needed } of PASS_KEYS)
    if (roleAtLeast(role, needed)) paths.push(`pass.${key}`);
  paths.push(...SCAN_KEYS.map((k) => `scan.${k}`), ...HISTORY_KEYS.map((k) => `history.${k}`));
  for (const action of manifest.scan?.actions ?? [])
    if (action.input && ['add', 'take', 'set'].includes(action.kind))
      paths.push(
        `history.ledger.${action.input}.last.at`,
        `history.ledger.${action.input}.last.amount`,
      );
  paths.push(...EVENT_KEYS.map((k) => `event.${k}`), 'scanner.name', 'scanner.role', 'now');
  for (const table of Object.keys(manifest.lookups ?? {})) paths.push(`lookups.${table}`);
  return paths;
}
