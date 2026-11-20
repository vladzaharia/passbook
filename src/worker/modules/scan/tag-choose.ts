import type { ScanTag } from '../../../shared/contracts/nfc-tags.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { doorConfirm } from '../nfc/policy.ts';
import { assuranceOfSystem } from '../nfc/systems/registry.ts';
import { isGuestPass } from './access.ts';
import type { ScanActor, ScanTagAuthority } from './actor.ts';
import { narrowToPass } from './admits.ts';
import type { TagFound } from './evaluate-tag.ts';
import type { Candidate } from './repo-lookup.ts';
import { accepts, matchesEvent } from './resolve-candidates.ts';
import { dropNfcOff } from './resolve-channels.ts';
import { evaluate } from './resolve-evaluate.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

/** At most this many of a user's passes are evaluated for one tag read (design §3.5). */
const EVALUATED = 4;

/** Step 5: inside first, active, members before guests, the anchor, oldest, id. */
function ordered(found: Extract<TagFound, { stop: null }>, list: Candidate[]): Candidate[] {
  const rank = (c: Candidate) => [
    found.inside.has(c.pass.id) ? 0 : 1,
    c.pass.status === 'voided' || c.pass.removedAt !== null ? 1 : 0,
    isGuestPass(c) ? 1 : 0,
    c.pass.id === found.tag.binding.passId ? 0 : 1,
    c.pass.createdAt,
  ];
  return [...list].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    return a.pass.id < b.pass.id ? -1 : a.pass.id > b.pass.id ? 1 : 0;
  });
}

export interface TagChoice {
  chosen: Candidate;
  actor: ScanActor;
  /** Desk and Manager only: a Door and customer screens never show tag data (§7.2). */
  view: ScanTag | null;
}

/**
 * Steps 4-7. A pass binding is today's single pass. A user binding never answers `ambiguous`: its passes this
 * scanner takes are evaluated in order; the first valid wins, else the first heads-up, else the first one's
 * refusal. A pin (the pass a resolve showed, a replayed scan's or an overridden scan's) is used as is, and
 * must still be one of the binding's passes.
 */
export async function chooseTagPass(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Extract<TagFound, { stop: null }>,
  options: { pin?: string | null; actionId?: string } = {},
): Promise<TagChoice | null> {
  const { tag } = found;
  const all = await dropNfcOff(ctx, found.candidates);
  const choice = (chosen: Candidate, passes?: ScanTag['passes']): TagChoice => {
    const authority: ScanTagAuthority = {
      tagId: tag.id,
      bindingId: tag.binding.id,
      scope: tag.binding.scope,
      userId: tag.binding.userId,
      passId: chosen.pass.id,
      assurance: assuranceOfSystem(tag.system),
      type: tag.type,
      confirm: doorConfirm(tag.type, tag.system, actor.settings.tags?.confirmBasic),
      ...(found.sun ? { sun: found.sun } : {}),
    };
    const desk = actor.role === 'desk' || actor.role === 'manager';
    const view: ScanTag | null = desk
      ? {
          hint: tag.hint,
          assurance: assuranceOfSystem(tag.system),
          system: tag.system,
          ...(tag.type ? { typeName: tag.type.name } : {}),
          scope: tag.binding.scope,
        }
      : null;
    if (view && tag.binding.scope === 'user') {
      view.count = all.length;
      if (passes) view.passes = passes;
    }
    const admitted = narrowToPass(actor, chosen.pass, ctx.clock.now());
    return { chosen, actor: { ...admitted, tag: authority }, view };
  };
  const pin = options.pin ?? null;
  if (pin !== null) {
    const pinned = all.find((c) => c.pass.id === pin);
    return pinned ? choice(pinned) : null;
  }
  const first = all[0];
  if (!first) return null;
  if (tag.binding.scope === 'pass' || all.length === 1) return choice(first);
  const taken = all.filter((c) => accepts(actor, c.pass));
  const matched = taken.filter((c) => matchesEvent(actor, c.pass));
  // None here: the first pass gives today's not_accepted or wrong_event.
  const ordering = ordered(found, matched);
  if (!ordering.length) return choice(taken[0] ?? first);
  // One fob is one person: a pass already inside answers alone, so a second pass never admits again.
  const inside = ordering[0] && found.inside.has(ordering[0].pass.id);
  const tried = inside ? ordering.slice(0, 1) : ordering;
  const verdicts = new Map<
    string,
    { kind: 'ok' | 'heads_up' | 'refused'; reason: string | null }
  >();
  for (const c of tried.slice(0, EVALUATED)) {
    const input = { passId: c.pass.id, method: 'nfc' as const };
    const refs = {
      credentialKeysetCommitment: c.credentialKeysetCommitment,
      credentialTombstoneRefs: [],
      otherModeCredentialTombstoneRefs: [],
    };
    const admitted = narrowToPass(actor, c.pass, ctx.clock.now());
    const evaluated = await evaluate(ctx, admitted, input, {}, refs, {
      candidateRead: { candidates: [structuredClone(c)] },
    });
    const lacksAction =
      !evaluated.stop &&
      options.actionId !== undefined &&
      options.actionId !== 'auto' &&
      !evaluated.found.scan.actions.some((a) => a.id === options.actionId);
    verdicts.set(
      c.pass.id,
      evaluated.stop
        ? { kind: evaluated.kind, reason: evaluated.reason }
        : lacksAction
          ? { kind: 'refused', reason: 'not_accepted' }
          : { kind: 'ok', reason: null },
    );
    if (!evaluated.stop && !lacksAction) break;
  }
  const pick =
    tried.find((c) => verdicts.get(c.pass.id)?.kind === 'ok') ??
    tried.find((c) => verdicts.get(c.pass.id)?.kind === 'heads_up') ??
    tried[0];
  if (!pick) return null;
  const passes: NonNullable<ScanTag['passes']> = [
    ...tried.map((c) => {
      const verdict = verdicts.get(c.pass.id);
      const state =
        c === pick
          ? 'used'
          : !verdict
            ? 'unchecked'
            : verdict.kind === 'ok'
              ? 'lets_in'
              : 'refused';
      return {
        passId: c.pass.id,
        templateName: resolveCandidateReadTemplates(c)?.active.manifest.name ?? null,
        state,
        reason: state === 'refused' ? (verdict?.reason ?? null) : null,
      } as const;
    }),
    ...all
      .filter((c) => !tried.includes(c))
      .map(
        (c) =>
          ({
            passId: null,
            templateName: null,
            state: 'not_here',
            reason: taken.includes(c) ? 'wrong_event' : 'not_accepted',
          }) as const,
      ),
  ];
  return choice(pick, passes);
}
