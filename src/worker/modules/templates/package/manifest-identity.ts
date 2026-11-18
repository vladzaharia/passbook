import { SCAN_ICONS } from '../../../../passkit/template/scan-display/icons.ts';
import { BLUEPRINT_GROUPS } from '../../../../passkit/types.ts';

const ICONS: ReadonlySet<string> = new Set(SCAN_ICONS);
const GROUPS: ReadonlySet<string> = new Set(BLUEPRINT_GROUPS);

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
  const display = m.display as Record<string, unknown> | undefined;
  const { group, aliases } = display ?? {};
  if (group !== undefined && (typeof group !== 'string' || !GROUPS.has(group)))
    error('MANIFEST_GROUP', 'display.group must be one of the gallery groups.', 'display.group');
  if (
    aliases !== undefined &&
    (!Array.isArray(aliases) ||
      aliases.length > 12 ||
      aliases.some((a) => typeof a !== 'string' || a.length === 0 || a.length > 32))
  )
    error(
      'MANIFEST_ALIASES',
      'display.aliases must be up to 12 words of 32 characters.',
      'display.aliases',
    );
  const icon = display?.icon;
  if (icon !== undefined && (typeof icon !== 'string' || !ICONS.has(icon)))
    error('MANIFEST_ICON', 'display.icon must be one of the curated icons.', 'display.icon');
}
