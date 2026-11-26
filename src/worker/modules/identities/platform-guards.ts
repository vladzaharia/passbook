import { ConflictError } from '../../platform/errors.ts';
import { PLATFORM_SLOTS } from './provision-platform.ts';
import type { IdentityRow } from './repo.ts';

const PLATFORM_PASS_TYPES: ReadonlySet<string> = new Set(
  Object.values(PLATFORM_SLOTS).map((s) => s.passType),
);

const protectedRow = (message: string) => new ConflictError(message, 'IDENTITY_PROTECTED');

/** The platform's own pass types are ordered at Apple by a platform run, never uploaded. */
export function assertUploadable(passTypeIdentifier: string): void {
  if (PLATFORM_PASS_TYPES.has(passTypeIdentifier))
    throw protectedRow('This pass type ID belongs to the platform.');
}

/** Platform slot rows change only through their platform run; a device-test row is never the default. */
export function assertPatchable(
  row: IdentityRow,
  patch: {
    isDefault?: boolean | undefined;
    apnsBinding?: string | null | undefined;
    rotation?: string | undefined;
  },
): void {
  if (patch.isDefault === true && row.purpose !== 'passes')
    throw protectedRow('Only a passes identity can be the default.');
  if (
    row.source === 'db' &&
    row.provenance === 'platform' &&
    (patch.isDefault !== undefined ||
      patch.apnsBinding !== undefined ||
      patch.rotation !== undefined)
  )
    throw protectedRow('A platform identity changes only through platform setup.');
}

export function assertDeletable(row: IdentityRow): void {
  if (row.source === 'db' && row.provenance === 'platform')
    throw protectedRow('A platform identity cannot be deleted. Stop issuing with it instead.');
}
