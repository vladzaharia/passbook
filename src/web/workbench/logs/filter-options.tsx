import { X } from 'lucide-react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import type { LogKey } from './api.ts';
import { keyTail } from './model.ts';

/** The key filter's choices: the org's Test keys by name, any key a row shows, and the one in the address. */
export function keyOptions(
  keys: readonly LogKey[],
  rows: readonly RequestLogEntry[],
  chosen?: string,
) {
  const names = new Map(keys.map((k) => [k.id, `${k.name} ${k.prefix}…`]));
  const ids = new Set<string>(keys.map((k) => k.id));
  for (const r of rows) if (r.keyId) ids.add(r.keyId);
  if (chosen) ids.add(chosen);
  return [...ids].map((id) => ({ value: id, label: names.get(id) ?? keyTail(id) }));
}

/** The versions rows pinned, and the one in the address. */
export function versionOptions(rows: readonly RequestLogEntry[], chosen?: string) {
  const all = new Set<string>(chosen ? [chosen] : []);
  for (const r of rows) if (r.apiVersion) all.add(r.apiVersion);
  return [...all]
    .sort()
    .reverse()
    .map((v) => ({ value: v, label: v }));
}

/** The Code filter lists the codes the rows (and the address) show. */
export function codeOptions(rows: readonly RequestLogEntry[], chosen?: string) {
  const codes = new Set<string>(chosen ? [chosen.toUpperCase()] : []);
  for (const r of rows) if (r.code) codes.add(r.code);
  return [...codes].sort().map((c) => ({ value: c, label: c }));
}

/** A scope the address carries with no list to pick from (a pass or template id): a chip with its clear. */
export function ScopeChip({
  label,
  value,
  clear,
  onClear,
}: {
  label: string;
  value: string;
  clear: string;
  onClear: () => void;
}) {
  return (
    <button
      type="button"
      className="bench-fs logs-scope"
      data-set=""
      aria-label={clear}
      onClick={onClear}
    >
      <span className="bench-fs-l">{label}</span>
      <span className="bench-fs-v">{value}</span>
      <X className="bench-fs-c" aria-hidden="true" />
    </button>
  );
}
