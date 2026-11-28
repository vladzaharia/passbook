import { grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { entitled } from '../../platform/authority-entitled.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

/** Who writes: an admin with passes:operate (or a passes:write key), or the bearer link of the pass. */
export interface PrintWriter {
  purpose: string;
  principal: Principal;
  checks: Check[];
  orgId: string;
  actor: { type: string; id: string | null };
  /** Stored as `created_by`: the user or key id, or `holder`. */
  by: string;
}

export const adminWriter = (
  authority: TenantPassWrite,
  actor: { type: string; id: string | null },
): PrintWriter => ({
  purpose: 'org_mode.prints.write',
  principal: tenantPrincipal(authority),
  checks: capabilityChecks(authority),
  orgId: authority.orgId,
  actor,
  by: actor.id ?? actor.type,
});

export const linkWriter = (pass: {
  id: string;
  orgId: string;
  downloadToken: string;
  linkGeneration: number;
  credentialGeneration: number;
}): PrintWriter => ({
  purpose: 'org_mode.pass.holder_print',
  principal: {
    kind: 'holder',
    passId: pass.id,
    proof: {
      via: 'link',
      downloadToken: pass.downloadToken,
      linkGeneration: pass.linkGeneration,
      credentialGeneration: pass.credentialGeneration,
    },
  },
  checks: [],
  orgId: pass.orgId,
  actor: { type: 'system', id: `link:${pass.id}` },
  by: 'holder',
});

const auditRow = (
  ctx: ServiceContext,
  w: PrintWriter,
  passId: string,
  action: string,
  detail: Record<string, unknown>,
) => ({
  at: ctx.clock.now(),
  orgId: w.orgId,
  actorType: w.actor.type,
  actorId: w.actor.id,
  action,
  targetType: 'pass',
  targetId: passId,
  requestId: ctx.requestId ?? null,
  ipPrefix: null,
  detail: JSON.stringify(detail),
});

const newGrant = (ctx: ServiceContext, w: PrintWriter, passId: string, extra: Check[] = []) =>
  grant(ctx, {
    purpose: w.purpose,
    principal: w.principal,
    target: passId,
    tables: ['pass_prints'],
    checks: [...w.checks, ...extra],
  });

export interface NewPrint {
  id: string;
  codeHash: string;
  rosterHash: string;
  generation: number;
  /** The pass version the print is made from. */
  passVersion: number;
  /** Hash of the drawing the print is made from; null when the ticket could not be drawn. */
  paperHash: string | null;
}

/**
 * A new print; with `replace` the pass's active print is voided as `replaced` in the same batch. Returns how many it voided.
 * Only a mint needs the org's plan to include print: a void always runs, so a downgrade never strands a ticket.
 */
export async function writeMint(
  ctx: ServiceContext,
  w: PrintWriter,
  passId: string,
  print: NewPrint,
  replace: boolean,
): Promise<number> {
  const g = newGrant(ctx, w, passId, [entitled('print', undefined, { testWaived: true })]);
  const now = ctx.clock.now();
  const voided = replace
    ? g.update('pass_prints', {
        set: { status: 'voided', voided_at: now, void_cause: 'replaced' },
        where: { pass_id: passId, status: 'active' },
        returning: ['id'],
      })
    : null;
  g.insertSelect(
    'pass_prints',
    [
      'id',
      'pass_id',
      'print_code_hash',
      'roster_hash',
      'generation',
      'pass_version',
      'paper_hash',
      'status',
      'created_by',
      'created_at',
    ],
    [
      print.id,
      passId,
      print.codeHash,
      print.rosterHash,
      print.generation,
      print.passVersion,
      print.paperHash,
      'active',
      w.by,
      now,
    ],
  );
  g.audit(
    auditRow(ctx, w, passId, 'pass.print', { printId: print.id, generation: print.generation }),
  );
  const results = await g.commit();
  return voided ? (results[g.indexOf(voided)]?.results?.length ?? 0) : 0;
}

/** Voids the pass's active print (or the named one); the number voided, audited when it is not zero. */
export async function writeVoid(
  ctx: ServiceContext,
  w: PrintWriter,
  passId: string,
  cause: string,
  printId?: string,
): Promise<number> {
  const g = newGrant(ctx, w, passId);
  const voided = g.update('pass_prints', {
    set: { status: 'voided', voided_at: ctx.clock.now(), void_cause: cause },
    where: { pass_id: passId, status: 'active', ...(printId ? { id: printId } : {}) },
    returning: ['id'],
  });
  g.audit(auditRow(ctx, w, passId, 'pass.print_void', { printId: printId ?? null, cause }));
  const results = await g.commit();
  return results[g.indexOf(voided)]?.results?.length ?? 0;
}

/**
 * Refresh: the active print was drawn again from the pass as it is now (its page, PDF or a bulk render). The
 * only write of `pass_version` and `paper_hash` after a mint. Not audited: nothing about the ticket changes.
 */
export async function writeRefresh(
  ctx: ServiceContext,
  w: PrintWriter,
  passId: string,
  printId: string,
  passVersion: number,
  hash: string,
): Promise<void> {
  const g = newGrant(ctx, w, passId);
  g.update('pass_prints', {
    set: { pass_version: passVersion, paper_hash: hash },
    where: { id: printId, pass_id: passId, status: 'active' },
  });
  await g.commit();
}
