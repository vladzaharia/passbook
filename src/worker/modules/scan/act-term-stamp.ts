import { firstScanInput } from '../../../passkit/behaviors/term/index.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { publishPass } from '../passes/publish.ts';
import { credentialFacts } from './act-check-in-facts.ts';
import type { ActRequest } from './act-claim.ts';
import { assertPassStill } from './act-value-mutate.ts';
import { ScanEffectStop } from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import type * as gates from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import { effectiveReleaseCheck } from './repo-scan-checks.ts';
import type { Found } from './resolve.ts';
import { SCAN_COMMIT_TABLES, scanWriteGrant } from './scan-write-grant.ts';

interface TermStamp {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  req: ActRequest;
  action: ResolvedScanAction;
  claim: gates.GateClaim;
  originalCandidate: Candidate | null;
  approver: { id: string; authEpoch: number } | null;
  /** When the scan committed. */
  at: number;
}

const filled = (v: unknown) => typeof v === 'string' && v !== '';

/**
 * A term that starts at the first scan (`term` with `firstScan`) gets its start input stamped once,
 * after the scan that let the pass in. The stamp only fills an empty input, so a later scan, a retry
 * or a racing scan leaves it where it is; the publish re-signs the pass with the computed end. The
 * scan is already committed: a stamp that cannot apply is logged and the next scan tries again.
 * Undoing the scan keeps the stamp: the term started when the pass was first presented.
 */
export async function stampTermStart(i: TermStamp): Promise<void> {
  const { ctx, actor, found, claim } = i;
  const input = firstScanInput(found.template.manifest);
  if (!input || filled(found.pass.personalization[input])) return;
  if (found.occupancy?.direction === 'out') return;
  const { actor: authority, event } = claim.authority;
  const credential =
    'code' in i.req.input
      ? await credentialFacts(found.pass, i.originalCandidate, i.req.input.code)
      : {};
  try {
    await publishPass(ctx, {
      passId: found.pass.id,
      orgScope: actor.orgId,
      cause: authority.actor.type === 'user' ? 'admin' : 'api',
      source: 'scan',
      actor: authority.actor,
      notify: false,
      commit: {
        open: (passChecks) =>
          scanWriteGrant(ctx, authority, {
            purpose: 'org_mode.scan.value',
            now: ctx.clock.now(),
            event: event ?? null,
            pass: { id: found.pass.id, facts: { pass: found.pass, credential } },
            approver: i.approver,
            credentialRefs: claim.credentialTombstoneRefs,
            checks: [
              ...passChecks,
              effectiveReleaseCheck(found.pass.id, found.liveCandidate?.templateSnapshot?.raw),
            ],
            tables: [...SCAN_COMMIT_TABLES, 'passes'],
            codes: {
              stale: 'PASS_CONFLICT',
              lineage: 'PASS_CONFLICT',
              release: 'TEMPLATE_RELEASE_CONFLICT',
            },
          }),
        when: [],
        add: async () => ({ settle() {} }),
      },
      mutate(current) {
        assertPassStill(current, found.pass, i.action);
        if (filled(current.personalization[input]))
          return { personalization: current.personalization };
        return {
          personalization: { ...current.personalization, [input]: new Date(i.at).toISOString() },
          fieldSources: { ...current.fieldSources, [input]: 'manual' },
        };
      },
    });
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'SCAN_TERM_STAMP';
    if (error instanceof ScanEffectStop || error instanceof AppError)
      ctx.log.info('scan.term_stamp_skipped', { orgId: actor.orgId, passId: found.pass.id, code });
    else
      ctx.log.error('scan.term_stamp_failed', {
        orgId: actor.orgId,
        passId: found.pass.id,
        code,
        error,
      });
  }
}
