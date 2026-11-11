import type { Mode } from '../../../shared/contracts/common.ts';
import { type Grant, grant, jobGrant } from '../../platform/authority.ts';
import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { Actor } from '../passes/service.ts';

/** A lost lineage on create is a stale selection; on a mutation the bundle has gone or changed. */
const CREATE_CODES: DenialOptions['codes'] = { lineage: 'BUNDLE_STALE', config: 'BUNDLE_STALE' };
const MUTATE_CODES: DenialOptions['codes'] = {
  lineage: 'BUNDLE_NOT_FOUND',
  config: 'BUNDLE_NOT_FOUND',
};

export interface NewBundle {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  token: string;
  holderEmail: string | null;
  actor: Actor;
  passes: Pick<
    Pass,
    'id' | 'linkGeneration' | 'credentialGeneration' | 'holderEmail' | 'ownerUserId'
  >[];
  now: number;
}

/** The live request's authority, or a job acting for the system (trusted workflows and fixtures). */
function bundleGrant(
  ctx: ServiceContext,
  o: {
    action: string;
    authority: TenantPassWrite | undefined;
    orgId: string;
    mode: Mode;
    checks: Check[];
    target: string;
    codes: DenialOptions['codes'];
  },
): Grant {
  const { authority } = o;
  const common = { checks: o.checks, target: o.target, codes: o.codes };
  return authority
    ? grant(ctx, {
        ...common,
        purpose: `org_mode.bundle.${o.action}`,
        principal: tenantPrincipal(authority),
        checks: [...capabilityChecks(authority), ...o.checks],
      })
    : jobGrant(ctx, {
        ...common,
        job: 'bundle',
        purpose: `org_mode.job.bundle_${o.action}`,
        orgId: o.orgId,
        mode: o.mode,
      });
}

/** No member may be quarantined test data: a quarantined pass blocks every bundle write. */
const noQuarantinedMembers = (bundleId: string): Check =>
  rawCheck(
    'lineage',
    `NOT EXISTS (SELECT 1 FROM bundle_passes bp JOIN passes p ON p.id = bp.pass_id
      WHERE bp.bundle_id = ? AND p.test_data_quarantined = 1)`,
    [bundleId],
  );

/** The bundle, its ordered members and the audit row: one batch under the creator's grant. */
export function createBundleGrant(
  ctx: ServiceContext,
  b: NewBundle,
  authority: TenantPassWrite | undefined,
  auditDetail: Record<string, unknown>,
): Grant {
  const members = JSON.stringify(
    b.passes.map((p) => ({
      id: p.id,
      linkGeneration: p.linkGeneration,
      credentialGeneration: p.credentialGeneration,
      holderEmail: p.holderEmail,
      ownerUserId: p.ownerUserId,
    })),
  );
  const g = bundleGrant(ctx, {
    action: 'create',
    authority,
    orgId: b.orgId,
    mode: b.mode,
    target: b.id,
    codes: CREATE_CODES,
    checks: [
      ...b.passes.map((p) => rowIs('passes', p.id)),
      rawCheck(
        'lineage',
        `NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (
          SELECT 1 FROM passes p WHERE p.id = json_extract(j.value, '$.id')
            AND p.link_generation = json_extract(j.value, '$.linkGeneration')
            AND p.credential_generation = json_extract(j.value, '$.credentialGeneration')
            AND p.holder_email IS json_extract(j.value, '$.holderEmail')
            AND p.owner_user_id IS json_extract(j.value, '$.ownerUserId')
            AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
            AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
              WHERE t.pass_id = p.id AND t.state = 'pending')))`,
        [members],
      ),
    ],
  });
  g.insertSelect(
    'bundles',
    ['id', 'name', 'token', 'holder_email', 'created_by_type', 'created_by_id', 'created_at'],
    [b.id, b.name, b.token, b.holderEmail, b.actor.type, b.actor.id, b.now],
  );
  for (const [position, pass] of b.passes.entries())
    g.insertJoined('bundle_passes', {
      parents: { bundle_id: b.id, pass_id: pass.id },
      columns: ['position'],
      values: [position],
    });
  g.add(
    grantedAudit(g, ctx, {
      orgId: b.orgId,
      actorType: b.actor.type,
      actorId: b.actor.id,
      action: 'bundle.create',
      targetType: 'bundle',
      targetId: b.id,
      detail: auditDetail,
    }),
  );
  return g;
}

/** Rotate the link or delete the bundle, with its audit row, while the bundle and its members hold. */
export function bundleMutationGrant(
  ctx: ServiceContext,
  o: {
    id: string;
    orgId: string;
    mode: Mode;
    authority: TenantPassWrite | undefined;
    actor: Actor;
    action: 'rotate_link' | 'delete';
    token?: string;
  },
): Grant {
  const g = bundleGrant(ctx, {
    action: o.action,
    authority: o.authority,
    orgId: o.orgId,
    mode: o.mode,
    target: o.id,
    codes: MUTATE_CODES,
    checks: [rowIs('bundles', o.id), noQuarantinedMembers(o.id)],
  });
  g.add(
    grantedAudit(g, ctx, {
      orgId: o.orgId,
      actorType: o.actor.type,
      actorId: o.actor.id,
      action: `bundle.${o.action}`,
      targetType: 'bundle',
      targetId: o.id,
    }),
  );
  if (o.action === 'rotate_link')
    g.update('bundles', {
      set: { token: o.token ?? '', token_rotated_at: ctx.clock.now() },
      where: { id: o.id },
      require: 'one',
    });
  else g.delete('bundles', { where: { id: o.id }, require: 'one' });
  return g;
}
