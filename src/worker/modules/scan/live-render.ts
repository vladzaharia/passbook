import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { assetBaseUrl, mintAssetGrant } from './assets.ts';
import type { liveRecipient } from './live-auth.ts';
import { canShowMemberPhoto } from './member-photo.ts';

export async function liveRowFor(
  ctx: ServiceContext,
  recipient: NonNullable<Awaited<ReturnType<typeof liveRecipient>>>,
  row: ScanLiveRow,
): Promise<ScanLiveRow | null> {
  const { actor, watch } = recipient;
  if (
    row.scannerId === actor.scanner?.id ||
    (!watch.allOrg && !watch.scannerIds.includes(row.scannerId))
  )
    return null;
  if (actor.scanner?.deviceRole === 'customer') {
    if (!row.presented || ctx.clock.now() - row.at > 10_000) return null;
    return {
      ...row,
      passId: null,
      holder: null,
      photoUrl: null,
      scannerName: '',
      label:
        row.kind === 'ok'
          ? row.direction === 'out'
            ? 'Checked out'
            : 'Checked in'
          : row.kind === 'ready'
            ? 'Please wait'
            : 'Please see the desk',
    };
  }
  let photoUrl: string | null = null;
  if (
    row.passId &&
    (await memberPhoto(ctx.env.DB, actor.orgId, row.passId)) &&
    (await canShowMemberPhoto(ctx, actor, row.passId))
  ) {
    const params = new URLSearchParams({
      g: await mintAssetGrant(ctx.env, actor.actorKey, row.passId, ctx.clock.now()),
      source: row.scannerId,
    });
    photoUrl = `${assetBaseUrl(row.passId).replace('/passes/', '/live/passes/')}member.png?${params}`;
  }
  return { ...row, photoUrl };
}
