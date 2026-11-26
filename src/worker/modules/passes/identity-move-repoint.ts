import { type Grant, jobGrant } from '../../platform/authority.ts';
import { notExists } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { CREATE_CODES } from './create-grant.ts';
import type { PublishCommit } from './publish.ts';
import type { MoveRow } from './repo-identity-move.ts';
import type { Repoint } from './repo-identity-move-state.ts';
import type { Pass } from './repo-map.ts';

/**
 * The statements that put the old pass's per-pass state on the replacement. They run before the pass write in
 * the same batch, so the void's own triggers (a print ends, a tag binding ends) find nothing left on the old
 * pass, and nothing ever points at a voided pass while the replacement is live.
 */
function addRepoint(
  g: Grant,
  a: { old: Pass; made: Pass; plan: Repoint; now: number; newId: () => string },
  externalId: string | null,
): void {
  const { old, made, plan, now } = a;
  // A bundle holds up to ten passes: the old pass leaves before the replacement joins.
  g.joined('bundle_passes', { via: 'pass_id', where: { pass_id: old.id }, delete: true });
  for (const b of plan.bundles)
    g.insertJoined('bundle_passes', {
      parents: { bundle_id: b.bundle_id, pass_id: made.id },
      columns: ['position'],
      values: [b.position],
      when: [notExists('bundle_passes', { bundle_id: b.bundle_id, pass_id: made.id })],
    });
  // The printed card keeps its code: the row follows the pass, and `code_pass_id` keeps naming the pass the code
  // was made for. A replacement that already has an active print of its own keeps it, and the old one ends.
  if (plan.print)
    g.update('pass_prints', {
      set: { pass_id: made.id, code_pass_id: plan.print.code_pass_id ?? old.id },
      where: { id: plan.print.id, pass_id: old.id, status: 'active' },
      when: [notExists('pass_prints', { pass_id: made.id, status: 'active' })],
    });
  for (const t of plan.tags) {
    g.joined('tag_bindings', {
      via: 'pass_id',
      where: { id: t.id, pass_id: old.id, scope: 'pass', ended_at: null },
      set: { ended_at: now, ended_by_type: 'system', ended_by: 'moves', end_cause: 'moved' },
    });
    g.insertJoined('tag_bindings', {
      parents: { tag_id: t.tag_id, pass_id: made.id },
      columns: [
        'id',
        'scope',
        'source',
        'bound_at',
        'bound_by_type',
        'bound_by',
        'scanner_id',
        'holder_generation',
        'holder_owner',
        'expires_at',
      ],
      values: [
        a.newId(),
        'pass',
        t.source,
        t.bound_at,
        t.bound_by_type,
        t.bound_by,
        t.scanner_id,
        made.credentialGeneration,
        made.ownerUserId,
        t.expires_at,
      ],
      when: [notExists('tag_bindings', { tag_id: t.tag_id, ended_at: null })],
    });
  }
  if (externalId !== null)
    g.update('passes', {
      set: { external_id: externalId },
      where: { id: made.id, external_id: null },
    });
}

/**
 * The commit hook of the old pass's void: its grant carries the re-pointing before the status write, so the
 * void and the move of everything the pass owns are one batch.
 */
export function moveVoidCommit(
  ctx: ServiceContext,
  row: MoveRow,
  a: { old: Pass; made: Pass; plan: Repoint },
): PublishCommit {
  return {
    when: [],
    open: (passChecks) => {
      const g = jobGrant(ctx, {
        purpose: 'org_mode.job.pass.identity_move_void',
        job: 'identity-move',
        orgId: row.org_id,
        mode: a.old.mode,
        target: a.old.id,
        checks: passChecks,
        codes: CREATE_CODES,
        tables: ['passes', 'scan_code_rotations', 'bundle_passes', 'pass_prints', 'tag_bindings'],
      });
      addRepoint(g, { ...a, now: ctx.clock.now(), newId: () => ctx.ids.id() }, a.old.externalId);
      return g;
    },
    add: async () => ({ settle() {} }),
  };
}
