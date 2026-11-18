import type { TemplateManifest } from '../../../passkit/types.ts';
import { ConflictError } from '../../platform/errors.ts';
import { type ExternalIdScope, externalIdTaken } from './repo-external-id.ts';

/** The template asks for one pass per external id (per org and mode). */
export const uniqueExternalIds = (manifest: Pick<TemplateManifest, 'externalId'>): boolean =>
  manifest.externalId?.unique === true;

/** Deleted passes release their id; removed and voided ones keep it. */
export async function assertExternalIdFree(
  db: D1Database,
  scope: ExternalIdScope,
  externalId: string,
  exceptPassId?: string,
): Promise<void> {
  if (await externalIdTaken(db, scope, externalId, exceptPassId))
    throw new ConflictError(
      'Another pass of this template has that externalId. Use a new one or update that pass.',
      'EXTERNAL_ID_TAKEN',
    );
}
