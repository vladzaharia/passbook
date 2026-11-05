import type { IdentityDto } from '../../../shared/contracts/identities.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { certDetails } from './cert.ts';
import { apnsBindingPresent } from './db-resolver.ts';
import { daysRemaining } from './expiry.ts';
import { type IdentityRow, identityFacts } from './repo.ts';
import { getPushKeyMeta, teamIdentityBindings } from './repo-push-keys.ts';

/** Apple's reason code from a probe's audit detail; null when it passed or none was given. */
function probeReason(detail: string | null): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    // Audit detail is written as JSON by probeRow; anything else carries no reason.
    return null;
  }
}

export async function toDto(ctx: ServiceContext, row: IdentityRow): Promise<IdentityDto> {
  const facts = await identityFacts(ctx.env.DB, row.id);
  let subject: string | null = null;
  let serial: string | null = null;
  if (row.cert_pem) {
    try {
      const details = await certDetails(row.cert_pem);
      subject = details.subject;
      serial = details.serial;
    } catch (error) {
      ctx.log.warn('identity.cert_unreadable', { identityId: row.id, error });
    }
  }
  const keyMeta = row.team_identifier
    ? await getPushKeyMeta(ctx.env.DB, row.team_identifier)
    : null;
  const bindings = keyMeta ? await teamIdentityBindings(ctx.env.DB, row.team_identifier) : [];
  const pushMethod = apnsBindingPresent(ctx.env, row.apns_binding)
    ? 'certificate'
    : keyMeta
      ? 'key'
      : 'none';
  return {
    id: row.id,
    orgId: row.org_id,
    label: row.label,
    passTypeIdentifier: row.pass_type_identifier,
    teamIdentifier: row.team_identifier,
    nfcKeys: [],
    source: row.source,
    certSha256: row.cert_sha256,
    certSubject: subject,
    certSerial: serial,
    notBefore: row.not_before,
    notAfter: row.not_after,
    daysRemaining: daysRemaining(row.not_after, ctx.clock.now()),
    apnsBinding: row.apns_binding,
    apnsAvailable: pushMethod !== 'none',
    pushMethod,
    pushKey: keyMeta
      ? {
          keyId: keyMeta.key_id,
          createdAt: keyMeta.created_at,
          rotatedAt: keyMeta.rotated_at,
          identityCount: bindings.length,
          dependentCount: bindings.filter((b) => !apnsBindingPresent(ctx.env, b.apns_binding))
            .length,
        }
      : null,
    apnsHealth: row.apns_health,
    apnsCheckedAt: facts.checked_at,
    apnsReason: probeReason(facts.detail),
    passCount: facts.pass_count,
    nfcEnabled: row.nfc_enabled === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  };
}
