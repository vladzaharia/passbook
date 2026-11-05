import type { IdentityDto } from '../../../shared/contracts/identities.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { certDetails } from './cert.ts';
import { apnsBindingPresent } from './db-resolver.ts';
import { daysRemaining } from './expiry.ts';
import { pushMethodOf } from './push-method.ts';
import { type IdentityRow, identityFacts } from './repo.ts';
import { bindingsOfTeams, listPushKeyMeta, type PushKeyMeta } from './repo-push-keys.ts';

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

interface TeamKeys {
  meta: Map<string, PushKeyMeta>;
  bindings: Map<string, { id: string; apns_binding: string | null }[]>;
}

/** Push key facts of the identities' teams, in two queries however many identities there are. */
async function loadTeamKeys(ctx: ServiceContext, rows: readonly IdentityRow[]): Promise<TeamKeys> {
  const teams = [...new Set(rows.map((r) => r.team_identifier).filter((t) => t !== ''))];
  const meta = new Map(
    (await listPushKeyMeta(ctx.env.DB, teams)).map((m) => [m.team_identifier, m]),
  );
  const bindings = new Map<string, { id: string; apns_binding: string | null }[]>();
  for (const b of await bindingsOfTeams(ctx.env.DB, [...meta.keys()]))
    bindings.set(b.team_identifier, [...(bindings.get(b.team_identifier) ?? []), b]);
  return { meta, bindings };
}

export async function toDtos(
  ctx: ServiceContext,
  rows: readonly IdentityRow[],
): Promise<IdentityDto[]> {
  const keys = await loadTeamKeys(ctx, rows);
  return Promise.all(rows.map((row) => dtoOf(ctx, row, keys)));
}

export async function toDto(ctx: ServiceContext, row: IdentityRow): Promise<IdentityDto> {
  return dtoOf(ctx, row, await loadTeamKeys(ctx, [row]));
}

async function dtoOf(ctx: ServiceContext, row: IdentityRow, keys: TeamKeys): Promise<IdentityDto> {
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
  const keyMeta = keys.meta.get(row.team_identifier) ?? null;
  const bindings = keys.bindings.get(row.team_identifier) ?? [];
  const pushMethod = pushMethodOf(ctx.env, row.apns_binding, keyMeta !== null);
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
