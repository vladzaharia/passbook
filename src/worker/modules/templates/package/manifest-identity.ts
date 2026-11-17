import { SCAN_ICONS } from '../../../../passkit/template/scan-display/icons.ts';

const ICONS: ReadonlySet<string> = new Set(SCAN_ICONS);

/** Only built-in packages may be blueprints; `display.icon` names a curated icon. */
export function checkIdentity(
  m: Record<string, unknown>,
  uploaded: boolean,
  error: (code: string, message: string, path?: string) => void,
): void {
  if (uploaded && m.blueprint !== undefined)
    error('MANIFEST_BLUEPRINT', 'Only built-in templates can be blueprints.', 'blueprint');
  else if (m.blueprint !== undefined && typeof m.blueprint !== 'boolean')
    error('MANIFEST_BLUEPRINT', 'blueprint must be true or false.', 'blueprint');
  const icon = (m.display as Record<string, unknown> | undefined)?.icon;
  if (icon !== undefined && (typeof icon !== 'string' || !ICONS.has(icon)))
    error('MANIFEST_ICON', 'display.icon must be one of the curated icons.', 'display.icon');
}
