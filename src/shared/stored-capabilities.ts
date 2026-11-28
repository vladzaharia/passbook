/**
 * Device reports at rest. Input stays strict (`ScanDeviceCapabilitiesSchema`); a stored row may
 * carry a field this Worker does not know yet (a newer release wrote it, then we rolled back), so
 * reads drop unknown keys at any depth instead of failing the whole row.
 */
import type { z } from 'zod';
import {
  type ScanDeviceCapabilities,
  ScanDeviceCapabilitiesSchema,
} from './contracts/scanning-sessions.ts';

const MAX_PASSES = 8;

function dropKeys(value: unknown, path: readonly PropertyKey[], keys: readonly string[]): void {
  let node = value as Record<PropertyKey, unknown> | undefined;
  for (const step of path) node = node?.[step] as Record<PropertyKey, unknown> | undefined;
  if (node && typeof node === 'object') for (const key of keys) delete node[key];
}

/**
 * Reports from before Screens left the layouts listed `customer` and `desk`: drop those entries.
 * Both fields are required, so a legacy `preferred` becomes the first layout left, and an empty
 * list becomes Handheld.
 */
function dropLegacyLayouts(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const report = value as { surfaces?: unknown; preferred?: unknown };
  const legacy = (v: unknown) => v === 'customer' || v === 'desk';
  if (Array.isArray(report.surfaces)) report.surfaces = report.surfaces.filter((v) => !legacy(v));
  if (Array.isArray(report.surfaces) && !report.surfaces.length) report.surfaces = ['phone'];
  if (legacy(report.preferred))
    report.preferred = Array.isArray(report.surfaces) ? report.surfaces[0] : 'phone';
}

/** Parses a stored report, dropping unknown keys. Null when it is not JSON or not a report. */
export function readStoredCapabilities(
  raw: string | null,
  onUnreadable?: (issue: string) => void,
): ScanDeviceCapabilities | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    onUnreadable?.('json');
    return null;
  }
  dropLegacyLayouts(value);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const parsed = ScanDeviceCapabilitiesSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    const unknown = parsed.error.issues.filter(
      (i): i is z.core.$ZodIssueUnrecognizedKeys => i.code === 'unrecognized_keys',
    );
    if (unknown.length !== parsed.error.issues.length) break;
    for (const issue of unknown) dropKeys(value, issue.path, issue.keys);
  }
  onUnreadable?.('shape');
  return null;
}
