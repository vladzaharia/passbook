// Who's in, for a scan actor: each name, photo and plan is exactly what this role's card for the pass shows.
import { applyDefaults } from '../../../../passkit/template/manifest.ts';
import { ConflictError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { accessManifestOf } from '../access.ts';
import { visibleIdentity } from '../card-semantics.ts';
import { cardPrivacy } from '../dto-projection.ts';
import type { ScanActor } from '../guard.ts';
import { knownPhotoUrl, photoGrantUrl, scannerPassActive } from '../member-photo.ts';
import { byIdStmt, candidatesOf } from '../repo-lookup.ts';
import { scanAuthorizedStmt, scanReadAuthority } from '../repo-read-authority.ts';
import { foundOf } from '../resolve.ts';
import type { Identify, WhoIdentity } from './inside-list.ts';

const HIDDEN: WhoIdentity = { holder: null, photoUrl: null, plan: null, host: null, ended: false };

/**
 * A pass this role cannot read, or one that no longer resolves, is listed without a name: it is
 * still inside. The actor's authority is re-read with the passes; if it lapsed, nothing is named.
 */
export function scanIdentify(
  ctx: ServiceContext,
  actor: ScanActor,
  keyset: string | null,
): Identify {
  return async (passIds) => {
    const out = new Map<string, WhoIdentity>();
    if (passIds.length === 0) return out;
    const now = ctx.clock.now();
    const auth = scanReadAuthority(actor, {
      now,
      read: { stafflessMonitor: actor.scanner?.deviceRole === 'monitor' && !actor.staff },
    });
    const results = await ctx.env.DB.batch<Record<string, unknown>>([
      scanAuthorizedStmt(ctx.env.DB, auth),
      ...passIds.map((id) => byIdStmt(ctx.env.DB, actor.orgId, id)),
    ]);
    if (results[0]?.results?.[0]?.authorized !== 1)
      throw new ConflictError('Configuration changed. Reload and retry.', 'SCAN_CONFIG_CHANGED');
    for (const id of passIds) out.set(id, HIDDEN);
    if (keyset === null) return out;
    for (const result of results.slice(1)) {
      for (const candidate of candidatesOf(result)) {
        if (candidate.pass.mode !== actor.mode || candidate.credentialKeysetCommitment !== keyset)
          continue;
        candidate.credentialTombstoneRefs = [];
        candidate.otherModeCredentialTombstoneRefs = [];
        const found = await foundOf(ctx, candidate, actor);
        if (!found) continue;
        const privacy = cardPrivacy(found, actor);
        const identity = visibleIdentity(found, actor, privacy);
        const photo = candidate.hasPhoto
          ? await knownPhotoUrl(ctx, actor, candidate, found.template, found.activePolicy)
          : null;
        const access = accessManifestOf(found);
        const inputs = access
          ? applyDefaults(found.activePolicy.manifest, candidate.pass.personalization)
          : null;
        const sponsor = access?.input.sponsor && inputs ? inputs[access.input.sponsor] : undefined;
        const host =
          typeof sponsor === 'string' && sponsor.trim() && privacy.safe(sponsor)
            ? sponsor.trim().slice(0, 80)
            : null;
        out.set(candidate.pass.id, {
          holder: identity.title,
          photoUrl:
            photo && photo.grant.expiresAt > now
              ? photoGrantUrl(actor, candidate.pass.id, photo.grant)
              : null,
          plan: access?.plans.find((p) => p.id === inputs?.[access.input.plan])?.label ?? null,
          host,
          ended: !scannerPassActive(candidate, found.passJson, now),
        });
      }
    }
    return out;
  };
}
