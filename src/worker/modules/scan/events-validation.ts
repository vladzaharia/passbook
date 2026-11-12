import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Json, Mode } from '../../../shared/contracts/common.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { countScopedTemplates, templateManifests } from './repo-event-templates.ts';
import { captureTemplateStamps, type TemplateStamps } from './repo-scope-releases.ts';

const SCALAR = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * Every template needs a check-in, and a match input must be a scalar input of each. An archived
 * template already on the event keeps working; `added` (new attachments) must be active.
 */
export async function checkTemplates(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  templateIds: string[],
  matchInput: string | null,
  added: readonly string[] = templateIds,
): Promise<TemplateStamps> {
  const db = ctx.env.DB;
  if ((await countScopedTemplates(db, orgId, templateIds)) !== templateIds.length)
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  if ((await countScopedTemplates(db, orgId, added, true)) !== added.length)
    throw new ValidationError(
      'An archived template cannot be added to an event.',
      [{ path: 'templateIds', message: 'Choose active templates.' }],
      'TEMPLATE_ARCHIVED',
    );
  const stamps = await captureTemplateStamps(db, orgId, mode, templateIds);
  if (!stamps)
    throw new ValidationError(
      'Every event template needs an approved release or an eligible legacy pass in this mode.',
      [{ path: 'templateIds', message: 'Choose templates available in this mode.' }],
      'EVENT_TEMPLATE_RELEASE_REQUIRED',
    );
  const templates = await templateManifests(db, orgId, stamps);
  const versionCount =
    stamps.releases.length + stamps.legacy.reduce((n, item) => n + item.versions.length, 0);
  if (templates.length !== versionCount)
    throw new ConflictError(
      'The event templates changed. Reload and try again.',
      'SCAN_EVENT_CHANGED',
    );
  for (const t of templates) {
    const manifest = JSON.parse(t.manifest) as TemplateManifest;
    if (!scanOf(manifest).actions.some((a) => a.kind === 'check_in'))
      throw new ValidationError(
        `${manifest.name} has no check-in action.`,
        [{ path: 'templateIds', message: 'Choose templates that check people in.' }],
        'EVENT_TEMPLATE_NO_CHECK_IN',
      );
    if (matchInput) {
      const prop = (manifest.inputs.properties?.[matchInput] ?? null) as { type?: Json } | null;
      if (
        !prop ||
        typeof prop.type !== 'string' ||
        !SCALAR.has(prop.type) ||
        /["\\]/.test(matchInput)
      )
        throw new ValidationError(
          `${manifest.name} has no single-value input called ${matchInput}.`,
          [{ path: 'match.input', message: 'Match on an input that holds one value.' }],
          'EVENT_MATCH_INPUT',
        );
    }
  }
  return stamps;
}

export function checkWindow(opensAt: number, closesAt: number): void {
  if (closesAt <= opensAt)
    throw new ValidationError('Closing must be after opening.', [
      { path: 'closesAt', message: 'Closing must be after opening.' },
    ]);
}
