import { actionLabel } from './actions.ts';

const MODE_NAME: Record<string, string> = { live: 'Live', test: 'Test' };

/**
 * The entry's sentence, naming where a release went ("Released v3 to Live"). An entry from before
 * the detail carried a version number reads "Template version released to Live"; with no mode, the plain label.
 */
export function entryLabel(entry: { action: string; detail: unknown }): string {
  const label = actionLabel(entry.action);
  if (entry.action !== 'template.release' && entry.action !== 'template.rollback') return label;
  const detail = entry.detail as { mode?: unknown; versionNumber?: unknown } | null;
  const name = typeof detail?.mode === 'string' ? MODE_NAME[detail.mode] : undefined;
  const n = typeof detail?.versionNumber === 'number' ? detail.versionNumber : undefined;
  if (entry.action === 'template.release' && n && name) return `Released v${n} to ${name}`;
  return name ? `${label} to ${name}` : label;
}
