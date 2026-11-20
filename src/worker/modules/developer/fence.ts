import { SANDBOX_PREVIEW_ONLY_COPY, TEST_PREVIEW_PATH } from '../../../shared/copy/developer.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';

/**
 * The owner's invariant (PX7): a developer org never issues a real wallet pass. No signed .pkpass, no Google or
 * Samsung object, no add-to-wallet link, no APNs push, no real mail. Every place that signs, mints, pushes or
 * sends for an org asks this first; `developer-fence.test.ts` finds those places in the code and fails when
 * one has no fence.
 */
export class PreviewOnlyError extends AppError {
  constructor() {
    super('SANDBOX_PREVIEW_ONLY', 409, SANDBOX_PREVIEW_ONLY_COPY);
  }
}

/** True for a developer org. An unknown org is not one (the caller's own org checks refuse it). */
export async function isPreviewOnlyOrg(db: D1Database, orgId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    "SELECT 1 AS ok FROM orgs WHERE id = ? AND kind = 'developer'",
    [orgId],
  );
  return row !== null;
}

/** Refuses a developer org with 409 SANDBOX_PREVIEW_ONLY. */
export async function assertNotPreviewOnly(db: D1Database, orgId: string): Promise<void> {
  if (await isPreviewOnlyOrg(db, orgId)) throw new PreviewOnlyError();
}

/** SQL form: true for an org that is not a developer org. `orgSql` is a trusted column. */
export const notPreviewOnlySql = (orgSql: string): string =>
  `NOT EXISTS (SELECT 1 FROM orgs dev_o WHERE dev_o.id = ${orgSql} AND dev_o.kind = 'developer')`;

/** The TEST preview page of a pass (PX9 renders it): public by its token, never installable. */
export const testPreviewUrl = (base: string, token: string): string =>
  `${base}${TEST_PREVIEW_PATH}${token}`;

/** The stored object of a preview-only pass: its JSON, never a package. */
export const PREVIEW_OBJECT_SUFFIX = '.preview.json';
export const PREVIEW_CONTENT_TYPE = 'application/json';
/** Refuses a stored preview object where a signed package is wanted (serving, bundling, attaching). */
export function assertSignedObject(objectKey: string): void {
  if (objectKey.endsWith(PREVIEW_OBJECT_SUFFIX)) throw new PreviewOnlyError();
}

/** The identity a preview-only pass validates against. It names no certificate and signs nothing. */
export const PREVIEW_PASS_IDENTITY = {
  passTypeIdentifier: 'pass.test.preview',
  teamIdentifier: 'TESTPREVIE',
} as const;
