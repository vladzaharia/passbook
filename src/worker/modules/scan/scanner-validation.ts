import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type CreateScannerSchema,
  ScannerSettingsSchema,
} from '../../../shared/contracts/index.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { eventModeOf } from './repo-scanners.ts';
import { countOrgTemplates, readValidEventScope } from './repo-scope.ts';

type Accepts = z.infer<typeof CreateScannerSchema>['accepts'];

const modeMismatch = () =>
  new ValidationError(
    'This event is in a different mode than the scanner.',
    [],
    'SCAN_MODE_MISMATCH',
  );

/** Event and template scopes require approved releases in this organization and mode. */
export async function checkAccepts(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  accepts: Accepts,
) {
  const db = ctx.env.DB;
  if ('eventId' in accepts) {
    const event = await eventModeOf(db, orgId, accepts.eventId);
    if (!event || event.archived_at !== null)
      throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
    if (event.mode !== mode) throw modeMismatch();
    if (!(await readValidEventScope(db, orgId, mode, accepts.eventId)))
      throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
    return { eventId: accepts.eventId, templateIds: [] as string[] };
  }
  const templateIds = [...new Set(accepts.templateIds)];
  if ((await countOrgTemplates(db, orgId, mode, templateIds)) !== templateIds.length)
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  return { eventId: null, templateIds };
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
