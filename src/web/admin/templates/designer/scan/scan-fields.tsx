import { checkExpr, exprReferences } from '@/passkit/template/expr.ts';
import { BINDING_STYLE_GROUPS } from '@/passkit/template/pointer.ts';
import { FILTERS } from '@/passkit/template/scan-display/format.ts';
import { SCAN_ICONS, type ScanIconId } from '@/passkit/template/scan-display/icons.ts';
import {
  type InputSchema,
  inputProps,
  isSecretInput,
  nameSegments,
  ROLE_RANK,
  scopeCatalog,
  secretInputs,
} from '@/passkit/template/scan-display/scope.ts';
import { parseParts, pathTokens, splitPath } from '@/passkit/template/scan-display/text.ts';
import type { ScanRole, TemplateManifest } from '@/passkit/types.ts';
import { Combobox, FormField, SegmentedControl } from '../../../../ui/index.ts';
import { type DesignDoc, isRecord } from '../model.ts';
import { privatePreviewKey, safePreviewText } from './scan-preview-policy.ts';

export type Manifest = DesignDoc['manifest'];
export type Pass = DesignDoc['passJson'];
export type Option = { value: string; label: string; disabled?: boolean };

export const effectiveScanRole = (parent: ScanRole = 'door', own?: ScanRole): ScanRole =>
  own && ROLE_RANK[own] > ROLE_RANK[parent] ? own : parent;

/** The designer also opens incomplete drafts. Only feed well-shaped data to the pure catalog. */
function catalogManifest(manifest: Manifest): {
  manifest: TemplateManifest;
  unsafeBarcode: boolean;
  unsafeFields: boolean;
} {
  const inputs = isRecord(manifest.inputs) ? manifest.inputs : {};
  const props = isRecord(inputs.properties) ? inputs.properties : {};
  const raw = Array.isArray(manifest.bindings) ? manifest.bindings : [];
  let unsafeBarcode = manifest.bindings !== undefined && !Array.isArray(manifest.bindings);
  let unsafeFields = unsafeBarcode;
  const bindings = raw.flatMap((binding) => {
    if (!isRecord(binding) || !isRecord(binding.to)) {
      unsafeBarcode = true;
      unsafeFields = true;
      return [];
    }
    if (typeof binding.value === 'string' && checkExpr(binding.value) !== null) {
      unsafeFields = true;
      if ('barcode' in binding.to && binding.to.prop === 'message') unsafeBarcode = true;
      return [];
    }
    return [binding];
  });
  const scan = isRecord(manifest.scan) ? manifest.scan : {};
  const actions = Array.isArray(scan.actions)
    ? scan.actions.filter((a) => isRecord(a) && typeof a.kind === 'string')
    : [];
  return {
    manifest: {
      inputs: { type: 'object', properties: props },
      bindings,
      scan: { actions },
      lookups: isRecord(manifest.lookups) ? manifest.lookups : {},
    } as unknown as TemplateManifest,
    unsafeBarcode,
    unsafeFields,
  };
}

/** Only field keys are inspected; literal Wallet values and barcode messages are never read. */
function catalogFieldKeys(pass: Pass | undefined): Set<string> {
  const keys = new Set<string>();
  if (!pass) return keys;
  for (const style of BINDING_STYLE_GROUPS.styles) {
    const block = pass[style];
    if (!isRecord(block)) continue;
    for (const group of BINDING_STYLE_GROUPS.groups) {
      const fields = block[group];
      if (!Array.isArray(fields)) continue;
      for (const field of fields)
        if (isRecord(field) && typeof field.key === 'string') keys.add(field.key);
    }
  }
  return keys;
}

export function words(path: string): string {
  return path.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ');
}

/** The editor never offers sensitive identifiers, even if a draft relaxes x-scan. */
function privateName(name: string, schema: InputSchema): boolean {
  const withoutOverride = { ...schema };
  delete withoutOverride['x-scan'];
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    isSecretInput(name, withoutOverride) ||
    privatePreviewKey(name) ||
    nameSegments(name).includes('contact') ||
    compact.includes('barcode') ||
    compact.includes('scancode')
  );
}

/** Options contain names only, never sample values. A secret is visible only as a disabled explanation. */
export function scanBindingOptions(
  manifest: Manifest,
  role: ScanRole = 'door',
  passJson?: Pass,
  allowedPaths?: readonly string[],
): Option[] {
  const safe = catalogManifest(manifest);
  const props = inputProps(safe.manifest);
  const secrets = secretInputs(safe.manifest);
  // A barcode source is private even when another binding also reads that input.
  for (const binding of safe.manifest.bindings) {
    if ('barcode' in binding.to && binding.to.prop === 'message' && binding.value !== undefined)
      for (const name of exprReferences(binding.value).inputs) secrets.add(name);
  }
  for (const [name, schema] of Object.entries(props))
    if (privateName(name, schema)) secrets.add(name);
  const catalog = scopeCatalog(safe.manifest, role);
  const catalogSet = new Set(catalog);
  const allowed = new Set(
    catalog.filter((path) => {
      if (!pathTokens(path) || !safePreviewText(path)) return false;
      if (path.startsWith('inputs.') && (safe.unsafeBarcode || secrets.has(path.slice(7))))
        return false;
      const ledger = /^history\.ledger\.([^.]+)\./.exec(path)?.[1];
      return (
        !ledger ||
        (!safe.unsafeBarcode && !secrets.has(ledger) && catalogSet.has(`inputs.${ledger}`))
      );
    }),
  );
  if (passJson && !safe.unsafeFields && !safe.unsafeBarcode) {
    const bound = new Map<string, boolean>();
    for (const binding of safe.manifest.bindings) {
      if (
        !('field' in binding.to) ||
        (binding.to.prop !== undefined && binding.to.prop !== 'value')
      )
        continue;
      // A lone, unconditional safe input replaces the Wallet field's value on every pass.
      // Literal, conditional, pass and mixed expressions cannot be proven safe here.
      const match =
        typeof binding.value === 'string' ? /^\{\{\s*([\w-]+)\s*\}\}$/.exec(binding.value) : null;
      const input = match?.[1];
      const proven = Boolean(
        input &&
          allowed.has(`inputs.${input}`) &&
          binding.when === undefined &&
          binding.remove === undefined,
      );
      for (const key of [binding.to.field].flat())
        if (typeof key === 'string') bound.set(key, (bound.get(key) ?? true) && proven);
    }
    for (const key of catalogFieldKeys(passJson)) {
      const path = `fields.${key}`;
      if (bound.get(key) && !privateName(key, {}) && pathTokens(path) && safePreviewText(path))
        allowed.add(path);
    }
  }
  if (allowedPaths)
    for (const path of allowed) if (!allowedPaths.includes(path)) allowed.delete(path);
  const options: Option[] = [...allowed].map((path) => ({ value: path, label: words(path) }));
  for (const name of Object.keys(props)) {
    const path = `inputs.${name}`;
    if (
      (secrets.has(name) || safe.unsafeBarcode) &&
      pathTokens(path) &&
      safePreviewText(path) &&
      (!allowedPaths || allowedPaths.includes(path))
    )
      options.push({
        value: path,
        label: `${words(path)} — Never shown on scanners`,
        disabled: true,
      });
  }
  return options;
}

export const pickerPaths = (options: Option[]) =>
  new Set(options.filter((o) => !o.disabled).map((o) => o.value));

/** Advanced edits are committed only if every reference is available at the element's role. */
export function safeScanExpression(source: string, options: Option[]): boolean {
  if (source.length > 512 || source.split('{{').length - 1 > 8) return false;
  const parts = parseParts(source).parts;
  if (!parts) return false;
  const paths = pickerPaths(options);
  return parts.every((part) => {
    if (!part.path) return safePreviewText(part.literal ?? '');
    const split = splitPath(part.path);
    const path =
      split?.root === 'inputs' && split.rest.length === 1 ? `inputs.${split.rest[0]}` : part.path;
    return (
      paths.has(path) && (!part.filter || (FILTERS as readonly string[]).includes(part.filter))
    );
  });
}

export function ScanRoleField({
  value,
  onChange,
  label = 'Who sees it',
}: {
  value: ScanRole | undefined;
  onChange: (value: ScanRole | undefined) => void;
  label?: string;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium text-fg-strong">{label}</span>
      <SegmentedControl
        label={label}
        block
        value={value ?? 'door'}
        onValueChange={(v) => onChange(v === 'door' ? undefined : v)}
        options={[
          { value: 'door', label: 'Everyone' },
          { value: 'desk', label: 'Desk and up' },
          { value: 'manager', label: 'Manager' },
        ]}
      />
    </div>
  );
}

export function ScanIconField({
  label = 'Icon',
  value,
  onChange,
  required = false,
}: {
  label?: string;
  value: ScanIconId | null | undefined;
  onChange: (value: ScanIconId | undefined) => void;
  required?: boolean;
}) {
  const options: Option[] = [
    ...(!required ? [{ value: '__none', label: 'None' }] : []),
    ...SCAN_ICONS.map((icon) => ({ value: icon, label: words(icon) })),
  ];
  return (
    <FormField label={label}>
      {(control) => (
        <Combobox
          {...control}
          options={options}
          value={value ?? (required ? undefined : '__none')}
          placeholder="Choose an icon"
          searchPlaceholder="Search icons"
          onValueChange={(v) => onChange(v === '__none' ? undefined : (v as ScanIconId))}
        />
      )}
    </FormField>
  );
}
