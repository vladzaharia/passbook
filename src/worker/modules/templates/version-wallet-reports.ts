import type { WalletReportsDto } from '../../../shared/contracts/wallet-fidelity.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { computeProjectionPins } from '../wallet-providers/projection-pins.ts';
import { getVersion } from './repo.ts';
import { loadTemplate } from './service.ts';

/**
 * The per-target fidelity report of a stored version, compiled from its own sample: what an
 * import shows after upload and what a release pins. Nothing is written.
 */
export async function versionWalletReports(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  version: string,
  orgId?: string,
): Promise<WalletReportsDto> {
  const row = await loadTemplate(ctx, auth, id, orgId);
  const v = await getVersion(ctx.env.DB, id, version);
  if (!v) throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
  const owner = row.orgId ?? undefined;
  const [google, samsung] = await Promise.all([
    computeProjectionPins(ctx, 'google', v, 'dry', owner),
    computeProjectionPins(ctx, 'samsung', v, 'dry', owner),
  ]);
  return { google: google.report, samsung: samsung.report };
}
