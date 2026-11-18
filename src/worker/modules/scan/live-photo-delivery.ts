import type { ServiceContext } from '../../platform/service-context.ts';
import { type LiveAttachment, liveRecipient } from './live-auth.ts';
import { watches } from './live-render.ts';
import type { LiveRingRow } from './live-ring.ts';
import { livePhotoStmt } from './repo-live-render.ts';
import { scanReadAuthority } from './repo-read-authority.ts';

export interface PreparedLivePhoto {
  photo: { r2_key: string; version: string };
  recheck(): Promise<boolean>;
}

/**
 * A monitor's photo for one retained live event: the recipient's authority, the scan, the pass at
 * the generations the scan saw, its image generation and its scope, in one statement. `recheck`
 * runs the same statement after the bytes are opened, so a change during the open refuses.
 */
export async function prepareLivePhoto(
  ctx: ServiceContext,
  attachment: LiveAttachment,
  entry: LiveRingRow,
): Promise<PreparedLivePhoto | null> {
  const read = async () => {
    const recipient = await liveRecipient(ctx, attachment);
    if (recipient?.actor.scanner?.deviceRole !== 'monitor') return null;
    const { actor } = recipient;
    const role = actor.role ?? entry.sourceRole;
    const now = ctx.clock.now();
    if (
      !watches(recipient, entry) ||
      !role ||
      !entry.photoRoles.includes(role) ||
      actor.settings.showPhoto === false ||
      (entry.validUntil !== null && now > entry.validUntil)
    )
      return null;
    const auth = scanReadAuthority(actor, { now, read: { stafflessMonitor: true } });
    const stmt = livePhotoStmt(ctx.env.DB, auth, actor, entry);
    return stmt ? stmt.first<{ r2_key: string; version: string }>() : null;
  };
  const photo = await read();
  if (!photo) return null;
  return {
    photo: { r2_key: photo.r2_key, version: photo.version },
    recheck: async () => {
      const again = await read();
      return again?.r2_key === photo.r2_key && again.version === photo.version;
    },
  };
}
