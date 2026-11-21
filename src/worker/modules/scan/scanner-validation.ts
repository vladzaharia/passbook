import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/index.ts';
import {
  ADMITS_TEMPLATE_CAP,
  type Admits,
  type AdmitsInput,
  admitsOf,
} from '../../../shared/contracts/scanners.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { storedAdmits } from './admits.ts';
import { countScopedTemplates } from './repo-event-templates.ts';
import { eventModeOf } from './repo-scanners.ts';
import { countOrgTemplates } from './repo-scope.ts';
import { readValidEventScopes } from './repo-scope-events.ts';

const modeMismatch = () =>
  new ValidationError(
    'This event is in a different mode than the scanner.',
    [],
    'SCAN_MODE_MISMATCH',
  );

/** Checked admits, and the single-shape part a scanner row stores. */
export interface CheckedAdmits {
  admits: Admits;
  /** A scanner row's event: the one event of an event-only scope, else null. */
  eventId: string | null;
  /** The template entries; a scanner row stores these. */
  templateIds: string[];
  eventIds: string[];
}

/**
 * Events and templates require approved releases in this organization and mode. A template
 * already `attached` to the scope may be archived (it keeps scanning); a newly added one must be active.
 */
export async function checkAccepts(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  accepts: AdmitsInput,
  attached: readonly string[] = [],
  /** Events the same batch creates, with their templates: not in the database yet. */
  made?: ReadonlyMap<string, readonly string[]>,
): Promise<CheckedAdmits> {
  const db = ctx.env.DB;
  const admits = admitsOf(accepts);
  const { templateIds, eventIds } = admits;
  const stored = eventIds.filter((id) => !made?.has(id));
  for (const id of stored) {
    const event = await eventModeOf(db, orgId, id);
    if (!event || event.archived_at !== null)
      throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
    if (event.mode !== mode) throw modeMismatch();
  }
  const events = await readValidEventScopes(db, orgId, mode, stored);
  if (!events) throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  if ((await countOrgTemplates(db, orgId, mode, templateIds)) !== templateIds.length)
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  const added = templateIds.filter((id) => !attached.includes(id));
  if ((await countScopedTemplates(db, orgId, added, true)) !== added.length)
    throw new ValidationError(
      'An archived template cannot be added to a scanner.',
      [{ path: 'accepts.templateIds', message: 'Choose active templates.' }],
      'TEMPLATE_ARCHIVED',
    );
  const named = new Set([
    ...templateIds,
    ...events.flatMap((e) => e.templateIds),
    ...eventIds.flatMap((id) => made?.get(id) ?? []),
  ]);
  if (named.size > ADMITS_TEMPLATE_CAP)
    throw new ValidationError(
      `Admit at most ${ADMITS_TEMPLATE_CAP} pass types, counting each event's.`,
      [{ path: 'accepts', message: 'Remove a pass type or an event.' }],
      'ADMITS_TOO_MANY',
    );
  const [only] = eventIds;
  const eventId = only !== undefined && eventIds.length === 1 && !templateIds.length ? only : null;
  return { admits, eventId, templateIds, eventIds };
}

/** The template entries a stored `accepts` names; none for an event, every template or an unreadable value. */
export function acceptedTemplateIds(raw: string | null): string[] {
  // An unreadable stored scope attaches nothing: every requested template counts as new.
  return storedAdmits(raw)?.templateIds ?? [];
}

export function requireScannerSettings(raw: string) {
  try {
    return ScannerSettingsSchema.parse(JSON.parse(raw));
  } catch {
    throw new ValidationError(
      'Correct this scanner’s settings first.',
      [],
      'SCAN_SETTINGS_INVALID',
    );
  }
}
