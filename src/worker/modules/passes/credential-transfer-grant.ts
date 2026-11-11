import { type Grant, grant, jobGrant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { first } from '../../platform/db.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { CredentialTransferAuthority } from './repo-credential-transfer-read.ts';

export type TransferPhase = 'start' | 'finish';

/** `stale` and `lineage` are the caller's to retry or report; `release` has its own code. */
export const TRANSFER_CODES: NonNullable<DenialOptions['codes']> = {
  stale: 'PASS_CONFLICT',
  lineage: 'PASS_CONFLICT',
  config: 'PASS_CONFLICT',
  release: 'TEMPLATE_RELEASE_CONFLICT',
};

const START_TABLES = [
  'passes',
  'pass_credential_transfers',
  'pass_credential_tombstones',
  'pass_credential_transfer_payloads',
  'pass_issuance_deliveries',
  'pass_attach_blocks',
  'pass_personalizations',
  'registrations',
  'bundle_passes',
  'outbox',
];
const FINISH_TABLES = [
  'passes',
  'pass_credential_transfers',
  'pass_credential_transfer_payloads',
  'pass_issuance_deliveries',
  'pass_events',
  'pass_assets',
  'member_photos',
  'pass_transfer_asset_gc',
  'pass_transfer_asset_candidates',
  'pass_transfer_asset_uploads',
];

export const tenantOf = (a: CredentialTransferAuthority): TenantPassWrite | undefined =>
  a.kind === 'session' || a.kind === 'api_key'
    ? a
    : a.kind === 'tenant-holder' || a.kind === 'verified-attach'
      ? a.authority
      : undefined;

function tenantAllowed(a: TenantPassWrite): boolean {
  return a.kind === 'session'
    ? a.capability === 'passes:operate'
    : a.scope === 'passes:write' || a.scope === 'holders:write';
}

export interface TransferPassRef {
  id: string;
  orgId: string;
  mode: 'live' | 'test';
}

const orgRevision = async (db: D1Database, orgId: string) =>
  (await first<{ r: number }>(db, 'SELECT access_revision AS r FROM orgs WHERE id = ?', [orgId]))
    ?.r;

function jobOf(
  ctx: ServiceContext,
  pass: TransferPassRef,
  purpose: string,
  checks: Check[],
  tables: string[],
  orgAccessRevision: number | undefined,
): Grant {
  return jobGrant(ctx, {
    purpose,
    job: purpose.replace('org_mode.job.', ''),
    orgId: pass.orgId,
    mode: pass.mode,
    ...(orgAccessRevision === undefined ? {} : { orgAccessRevision }),
    target: pass.id,
    checks,
    codes: TRANSFER_CODES,
    tables,
  });
}

/**
 * The grant a credential transfer step runs under, chosen by who authorised it (authority-epochs.md 8.4):
 * a tenant session or key; the verified owner attaching, or the owner removing, on the holder principal;
 * and queued or connector work on a job grant (`jobGrant` refuses a request context). Returns null when the tenant authority is not allowed to
 * transfer, which the caller reports as a conflict. A step without authority (the sweep) is a job.
 */
export async function transferGrant(
  ctx: ServiceContext,
  authority: CredentialTransferAuthority | undefined,
  phase: TransferPhase,
  pass: TransferPassRef,
  checks: Check[],
): Promise<Grant | null> {
  const tables = phase === 'start' ? START_TABLES : FINISH_TABLES;
  const base = { target: pass.id, codes: TRANSFER_CODES, tables };
  const tenant = authority && tenantOf(authority);
  if (tenant) {
    if (!tenantAllowed(tenant)) return null;
    return grant(ctx, {
      ...base,
      purpose: `org_mode.pass.transfer_${phase}`,
      principal: tenantPrincipal(tenant),
      checks: [...capabilityChecks(tenant), ...checks],
    });
  }
  const holder = (purpose: string, principal: Principal) =>
    grant(ctx, { ...base, purpose, principal, checks });
  if (authority?.kind === 'verified-attach')
    return holder('org_mode.pass.holder_attach', {
      kind: 'holder',
      passId: pass.id,
      proof: { via: 'verified_email', userId: authority.userId },
    });
  if (authority?.kind === 'self-remove')
    return holder('org_mode.pass.holder_remove', {
      kind: 'holder',
      passId: pass.id,
      proof: { via: 'session', userId: authority.userId, sessionIdHash: authority.sessionId },
    });
  const purpose =
    phase === 'finish'
      ? 'org_mode.job.pass.transfer_finish'
      : authority?.kind === 'connection'
        ? 'org_mode.job.pass.connection_transfer'
        : 'org_mode.job.pass.holder_change';
  return jobOf(ctx, pass, purpose, checks, tables, await orgRevision(ctx.env.DB, pass.orgId));
}

/** A refusal the step reports as "not done, the row moved"; anything else is rethrown. */
export const CONFLICT_CODES = new Set(['PASS_CONFLICT', 'TEMPLATE_RELEASE_CONFLICT']);

/** `pass_id = {pass}` for a holder grant, `pass_id = ?` otherwise: the part's pass-id comparison. */
export function passIs(g: Grant, passId: string, column = 'pass_id') {
  return g.principal.kind === 'holder'
    ? { sql: `${column} = {pass}`, params: [] as string[] }
    : { sql: `${column} = ?`, params: [passId] };
}

/** The connector payload rows, tied to the transfer of the pass (the form a holder grant requires). */
export function payloadPart(
  g: Grant,
  passId: string,
  op: 'delete' | 'insert',
  transferId: string,
  env?: { kekVersion: number; iv: unknown; wrappedDek: unknown; ciphertext: unknown },
) {
  const at = passIs(g, passId, 'pt.pass_id');
  if (op === 'delete')
    return writePart(
      `DELETE FROM pass_credential_transfer_payloads WHERE EXISTS (SELECT 1 FROM pass_credential_transfers pt
        WHERE pt.id = pass_credential_transfer_payloads.transfer_id AND pt.id = ? AND ${at.sql}) AND {grant}`,
      [transferId, ...at.params],
    );
  return writePart(
    `INSERT INTO pass_credential_transfer_payloads (transfer_id,kek_version,iv,wrapped_dek,ciphertext)
      SELECT pt.id, ?, ?, ?, ? FROM pass_credential_transfers pt
      WHERE pt.id = ? AND ${at.sql} AND {grant}`,
    [
      env?.kekVersion as never,
      env?.iv as never,
      env?.wrappedDek as never,
      env?.ciphertext as never,
      transferId,
      ...at.params,
    ],
  );
}
