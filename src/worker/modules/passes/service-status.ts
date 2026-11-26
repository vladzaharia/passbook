import type { PassSource } from '../../../shared/contracts/passes.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { dropPrintPdfs } from '../prints/pdf-drop.ts';
import { pinnedStatus, type RunWrite } from './bulk-write.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { type PublishCommit, publishPass } from './publish.ts';
import type { Pass } from './repo-map.ts';
import type { ScopeArg } from './scope.ts';

type Actor = Parameters<typeof publishPass>[1]['actor'];
const causeOf = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');

/** What a run that voids or restores many passes adds to the one status write (change runs). */
export interface StatusExtras {
  extraChecks?: readonly Check[];
  source?: PassSource;
  sourceRef?: string;
  notify?: boolean;
  expectedVersion?: number;
  /** Throws when the pass is no longer the one the run read; re-run on every retry. */
  guard?: (current: Pass) => void;
  /** A bulk run's pins and id (find-and-act runs): the pass must still be at the run's version. */
  runWrite?: RunWrite;
  /** Rows that commit with the status write, in its grant (an identity move's re-pointed state). */
  commit?: PublishCommit;
  /** Changes the pass's `externalId` in the same write (null clears it). */
  externalId?: string | null;
}

/** The void or restore of one pass with everything it owns: its events, its audit row and its print PDFs. */
export async function setPassStatus(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  status: 'active' | 'voided',
  scope: ScopeArg,
  authority?: TenantPassWrite,
  extras: StatusExtras = {},
) {
  const current = await getPassForWrite(ctx.env.DB, passId, scope);
  if (current.removedAt !== null)
    throw new ConflictError('This pass was removed from Wallet. Restore it first.', 'PASS_REMOVED');
  const run = extras.runWrite;
  const checks = [...(extras.extraChecks ?? []), ...(run?.checks ?? [])];
  const pin = pinnedStatus(run, status);
  const result = await publishPass(ctx, {
    passId,
    orgScope: scope,
    cause: causeOf(actor),
    actor,
    ...(authority ? { authority } : {}),
    ...(checks.length > 0 ? { extraChecks: checks } : {}),
    ...(extras.source ? { source: extras.source } : {}),
    ...(extras.sourceRef ? { sourceRef: extras.sourceRef } : {}),
    ...(extras.notify === undefined ? {} : { notify: extras.notify }),
    ...(extras.commit ? { commit: extras.commit } : {}),
    ...(extras.expectedVersion === undefined ? {} : { expectedVersion: extras.expectedVersion }),
    ...(checks.length > 0 ? { dispatch: false } : {}),
    mutate: (cur) => {
      extras.guard?.(cur);
      return extras.externalId === undefined
        ? pin(cur)
        : { ...pin(cur), externalId: extras.externalId };
    },
  });
  // A void ends the pass's prints (a trigger), so their PDFs, single and bulk, go too.
  if (status === 'voided') await dropPrintPdfs(ctx, result.pass);
  await recordAudit(ctx, {
    orgId: result.pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: status === 'voided' ? 'pass.void' : 'pass.unvoid',
    targetType: 'pass',
    targetId: passId,
    ...(run ? { detail: { runId: run.runId } } : {}),
  });
  await recordPassEvent(ctx, {
    orgId: result.pass.orgId,
    passId,
    mode: result.pass.mode,
    kind: status === 'voided' ? 'pass.voided' : 'pass.unvoided',
    actor,
    ...(run ? { data: { runId: run.runId } } : {}),
  });
  return result;
}
