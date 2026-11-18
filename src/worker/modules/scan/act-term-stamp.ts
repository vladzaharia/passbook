import { stampInput } from '../../../passkit/behaviors/term/index.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { type Mutation, publishPass } from '../passes/publish.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { credentialFacts } from './act-check-in-facts.ts';
import type { ActRequest } from './act-claim.ts';
import { assertPassStill } from './act-value-mutate.ts';
import { ScanEffectStop } from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import type * as gates from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import { effectiveReleaseCheck } from './repo-scan-checks.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { otherStandingScans } from './repo-term-stamp.ts';
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
}

const filled = (v: unknown) => typeof v === 'string' && v !== '';

function logSkipped(ctx: ServiceContext, orgId: string, passId: string, error: unknown) {
  const base = { orgId, passId };
  if (error instanceof ScanEffectStop || error instanceof AppError)
    ctx.log.info('scan.term_stamp_skipped', {
      ...base,
      code: error instanceof AppError ? error.code : 'SCAN_TERM_STAMP',
    });
  else ctx.log.error('scan.term_stamp_failed', { ...base, code: 'SCAN_TERM_STAMP', error });
}

/**
 * A term that starts at the first scan (`term` with `startOn: 'first-scan'`) gets its start input
 * stamped once, after the scan that let the pass in. The stamp only fills an empty input, so a
 * later scan, a retry or a racing scan leaves it where it is; the publish re-signs the pass with
 * the computed end. It runs after the response (`ctx.waitUntil`): the scan is already committed,
 * and one that cannot stamp is logged and retried by the next scan. Check-ins and value actions
 * both call it. A connection-owned input is never written.
 */
export function deferTermStart(i: TermStamp): void {
  i.ctx.waitUntil(stampTermStart(i));
}

export async function stampTermStart(i: TermStamp): Promise<void> {
  const { ctx, actor, found, claim } = i;
  const input = stampInput(found.template.manifest, 'first-scan');
  if (!input || filled(found.pass.personalization[input])) return;
  if (found.pass.fieldSources[input] === 'connection') return;
  const direction = found.occupancy?.direction ?? found.admission?.state.direction;
  if (direction === 'out') return;
  const { actor: authority, event } = claim.authority;
  try {
    const credential =
      'code' in i.req.input
        ? await credentialFacts(found.pass, i.originalCandidate, i.req.input.code)
        : {};
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
      mutate(current): Mutation {
        assertPassStill(current, found.pass, i.action);
        if (filled(current.personalization[input]) || current.fieldSources[input] === 'connection')
          return { personalization: current.personalization };
        return {
          // The scan row's own time, so an undo can tell the stamp is its own.
          personalization: { ...current.personalization, [input]: iso(claim.claimAt) },
          fieldSources: { ...current.fieldSources, [input]: 'manual' },
        };
      },
    });
  } catch (error) {
    logSkipped(ctx, actor.orgId, found.pass.id, error);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

interface TermClear {
  ctx: ServiceContext;
  actor: ScanActor;
  target: { id: string; passId: string; at: number };
  event: ScanEventRow | null;
  approver: { id: string; authEpoch: number } | null;
}

/**
 * Undoing the scan that started a term takes the start back, so a pass scanned by mistake does
 * not begin its term. Only when the input still holds that scan's time and no other scan of the
 * pass still stands; the write is one compare-and-swap on the pass, so a later stamp is never
 * cleared. Deferred like the stamp; a failure leaves the stamp in place.
 */
export function deferTermClear(i: TermClear): void {
  i.ctx.waitUntil(clearTermStart(i));
}

export async function clearTermStart(i: TermClear): Promise<void> {
  const { ctx, actor, target } = i;
  try {
    const pass = await getPass(ctx.env.DB, target.passId, actor.orgId);
    if (!pass) return;
    const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
    const input = stampInput(template.manifest, 'first-scan');
    if (!input || pass.personalization[input] !== iso(target.at)) return;
    if (await otherStandingScans(ctx.env.DB, actor.orgId, pass.id, target.id)) return;
    await publishPass(ctx, {
      passId: pass.id,
      orgScope: actor.orgId,
      cause: actor.actor.type === 'user' ? 'admin' : 'api',
      source: 'scan',
      actor: actor.actor,
      notify: false,
      commit: {
        open: (passChecks) =>
          scanWriteGrant(ctx, actor, {
            purpose: 'org_mode.scan.undo',
            now: ctx.clock.now(),
            event: i.event,
            pass: { id: pass.id, facts: { pass, credential: {} } },
            approver: i.approver,
            checks: passChecks,
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
      mutate(current: Pass): Mutation {
        if (current.personalization[input] !== iso(target.at)) return {};
        const { [input]: _gone, ...rest } = current.personalization;
        const { [input]: _source, ...sources } = current.fieldSources;
        return { personalization: rest, fieldSources: sources };
      },
    });
  } catch (error) {
    logSkipped(ctx, actor.orgId, target.passId, error);
  }
}
