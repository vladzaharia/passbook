import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import { grant, jobGrant } from '../../platform/authority.ts';
import { passRow, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { connectionIs } from '../connections/repo-grants.ts';
import { CREATE_CODES, createRefusal } from './create-grant.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { FieldSources, Pass } from './repo-map.ts';

/**
 * Binds or unbinds only the exact pass and target connection that were reviewed, in the tenant's grant.
 * False when the pass or connection moved since the read; a lost org or actor is a 403.
 */
export async function setBinding(
  ctx: ServiceContext,
  pass: Pass,
  binding: {
    connectionId: string | null;
    externalRef: string | null;
    fieldSources: FieldSources;
    generation: number | null;
    connectionMode: ConnectionMode | null;
  },
  authority?: TenantPassWrite,
): Promise<boolean> {
  if (authority && (authority.orgId !== pass.orgId || authority.mode !== pass.mode)) return false;
  const bound = binding.connectionId !== null;
  if (bound && (pass.mode !== 'live' || binding.generation === null)) return false;
  const checks = [
    ...(authority ? capabilityChecks(authority) : []),
    ...passRow(pass.id, pass.rowVersion),
    rowIs(
      'passes',
      pass.id,
      {
        lifecycle_generation: pass.lifecycleGeneration,
        credential_generation: pass.credentialGeneration,
        link_generation: pass.linkGeneration,
        test_data_quarantined: 0,
        removed_at: null,
        deleted_at: null,
      },
      'lineage',
    ),
    rawCheck(
      'lineage',
      "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
      [pass.id],
    ),
    ...(binding.connectionId !== null && binding.generation !== null
      ? [
          connectionIs({
            id: binding.connectionId,
            generation: binding.generation,
            ...(binding.connectionMode ? { syncMode: binding.connectionMode } : {}),
            enabled: true,
          }),
        ]
      : []),
  ];
  const common = { target: pass.id, tables: ['passes'], codes: CREATE_CODES, checks };
  // A request binds as its tenant; only a queue, cron or workflow context may bind without one.
  const g = authority
    ? grant(ctx, {
        ...common,
        purpose: 'org_mode.pass.bind_connection',
        principal: tenantPrincipal(authority),
      })
    : jobGrant(ctx, {
        ...common,
        purpose: 'org_mode.job.pass.bind_connection',
        job: 'pass-bind',
        orgId: pass.orgId,
        mode: pass.mode,
      });
  g.update('passes', {
    set: {
      connection_id: binding.connectionId,
      external_ref: binding.externalRef,
      field_sources: JSON.stringify(binding.fieldSources),
      sync_error_code: null,
      refresh_requested_at: null,
    },
    inc: ['version'],
    where: {
      id: pass.id,
      version: pass.version,
      connection_id: pass.connectionId,
      external_ref: pass.externalRef,
    },
    returning: ['id'],
  });
  try {
    const [result] = await g.commit();
    return (result?.results.length ?? 0) === 1;
  } catch (error) {
    const reason = createRefusal(error);
    if (reason === null || reason === 'org' || reason === 'actor') throw error;
    return false;
  }
}
