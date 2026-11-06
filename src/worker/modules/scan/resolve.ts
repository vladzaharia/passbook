import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson, PassStyle } from '../../../passkit/types.ts';
import { PASS_STYLES } from '../../../passkit/types.ts';
import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import type { ScanInput, ScanReason } from '../../../shared/contracts/scan.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import { type ResolvedScanManifest, scanOf } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound, resolveTemplate } from '../passes/builder.ts';
import type { Pass } from '../passes/repo-map.ts';
import { planAdmission, policyAction } from './admission.ts';
import type { AdmissionPlan } from './admission-types.ts';
import { barcodeHashOfCode, cleanCode, codeKeyOf, lookupHashOf } from './codes.ts';
import type { ScanActor } from './guard.ts';
import { knownPhotoUrl } from './member-photo.ts';
import {
  byBarcodeHashStmt,
  byExternalIdStmt,
  byIdStmt,
  byLookupHashStmt,
  byScanCodeStmt,
  bySerialStmt,
  type Candidate,
  candidateById,
  candidatesOf,
} from './repo-lookup.ts';

export interface TemplateRef {
  name: string;
  style: string;
}

export interface Found {
  pass: Pass;
  passJson: PassJson;
  template: ResolvedTemplate;
  scan: ResolvedScanManifest;
  ref: TemplateRef;
  photoUrl?: string | null;
  checkInRules?: CheckInPolicy;
  admission?: AdmissionPlan;
}

/** Everything a stop step knows: the pass and template only when a step got far enough to find them. */
export interface Stop {
  stop: true;
  kind: 'refused' | 'heads_up';
  reason: ScanReason;
  pass: Pass | null;
  ref: TemplateRef | null;
  /** The time the copy names: when it opens, ended, was removed or voided. */
  at: number | null;
  flags: string[];
  found: Found | null;
  hard?: boolean;
}
export type Evaluated = { stop: false; found: Found } | Stop;

/** What an override of an earlier heads-up waives; every other step still runs. */
export interface Waive {
  window?: boolean;
  /** The flags were acknowledged. */
  confirmed?: boolean;
  direction?: 'in' | 'out';
}

const MINUTE = 60_000;

export const styleOf = (passJson: PassJson): string =>
  PASS_STYLES.find((s: PassStyle) => s in passJson) ?? 'generic';

const stop = (
  kind: Stop['kind'],
  reason: ScanReason,
  more: Partial<Omit<Stop, 'stop' | 'kind' | 'reason'>> = {},
): Stop => ({
  stop: true,
  kind,
  reason,
  pass: null,
  ref: null,
  at: null,
  flags: [],
  found: null,
  ...more,
});

async function findCandidates(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanInput,
): Promise<Candidate[]> {
  const db = ctx.env.DB;
  if ('passId' in input) {
    const one = await candidateById(db, actor.orgId, input.passId);
    return one ? [one] : [];
  }
  const clean = cleanCode(input.code);
  if (clean === '') return [];
  const key = codeKeyOf(clean);
  if (key) {
    const hit = candidatesOf(await byScanCodeStmt(db, actor.orgId, key).all());
    if (hit.length > 0) return hit;
  }
  const statements = [
    byBarcodeHashStmt(db, actor.orgId, await barcodeHashOfCode(clean)),
    byLookupHashStmt(db, actor.orgId, await lookupHashOf(clean)),
    ...(input.method === 'manual'
      ? [
          byExternalIdStmt(db, actor.orgId, clean),
          bySerialStmt(db, actor.orgId, clean),
          byIdStmt(db, actor.orgId, clean),
        ]
      : []),
  ];
  for (const result of await db.batch(statements)) {
    const hit = candidatesOf(result);
    if (hit.length > 0) return hit;
  }
  return [];
}

const accepts = (actor: ScanActor, pass: Pass) =>
  actor.templateIds.length === 0
    ? (actor.principal === 'admin' && actor.scanner === null) ||
      actor.settings.acceptAllTemplates === true
    : actor.templateIds.includes(pass.templateId);

function matchesEvent(actor: ScanActor, pass: Pass): boolean {
  const event = actor.event;
  if (!event?.matchInput || !event.matchValues) return true;
  const values = JSON.parse(event.matchValues) as unknown[];
  return values.map(String).includes(String(pass.personalization[event.matchInput]));
}

export async function foundOf(
  ctx: ServiceContext,
  c: Candidate,
  actor?: ScanActor,
): Promise<Found | null> {
  try {
    const template = await resolveTemplate(
      ctx,
      c.pass.orgId,
      c.pass.templateId,
      c.pass.templateVersion,
    );
    const passJson = (c.passJson ? JSON.parse(c.passJson) : template.passJson) as PassJson;
    const rules = c.checkInRules ?? {};
    const scan = scanOf(template.manifest);
    return {
      pass: c.pass,
      passJson,
      template,
      scan: {
        ...scan,
        actions: scan.actions.map((action) =>
          policyAction(action, {
            ...rules,
            mode: rules.mode ?? actor?.settings.checkIn?.mode,
          }),
        ),
      },
      checkInRules: rules,
      ref: { name: template.manifest.name, style: styleOf(passJson) },
      photoUrl: actor && c.hasPhoto ? await knownPhotoUrl(ctx, actor, c, template) : null,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

const instant = (value: unknown): number | null => {
  const t = typeof value === 'string' ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

function windowStop(actor: ScanActor, found: Found, now: number, waive: Waive): Stop | null {
  const withFound = { pass: found.pass, ref: found.ref, found };
  const w = found.scan.window;
  if (w && !waive.window) {
    const from = w.from ? instant(found.pass.personalization[w.from]) : null;
    const until = w.until ? instant(found.pass.personalization[w.until]) : null;
    const opens =
      found.checkInRules?.validFrom !== undefined
        ? found.checkInRules.validFrom
        : from === null
          ? null
          : from - (w.earlyMinutes ?? 0) * MINUTE;
    const closes =
      found.checkInRules?.validUntil !== undefined
        ? found.checkInRules.validUntil
        : until === null
          ? null
          : until + (w.lateMinutes ?? 0) * MINUTE;
    if (opens !== null && now < opens)
      return stop('heads_up', 'not_yet_valid', { ...withFound, at: opens });
    if (closes !== null && now > closes)
      return stop('heads_up', 'ended', { ...withFound, at: closes });
  }
  const event = actor.event;
  if (event && !waive.window) {
    if (now < event.opensAt)
      return stop('heads_up', 'not_yet_valid', { ...withFound, at: event.opensAt });
    if (now > event.closesAt)
      return stop('heads_up', 'ended', { ...withFound, at: event.closesAt });
  }
  return null;
}

/** The flags that are on for this pass (SA 4.1); a stop flag holds the check-in until confirmed. */
export function activeFlags(found: Found): { label: string; stop: boolean }[] {
  return (found.scan.flags ?? []).flatMap((f) => {
    const value = found.pass.personalization[f.input];
    const on = f.equals
      ? f.equals.includes(String(value))
      : value !== undefined && value !== null && value !== '' && value !== false && value !== 0;
    return on ? [{ label: f.label, stop: f.stop === true }] : [];
  });
}

/** SA 2.6 steps 5-13. Never writes. A found pass that passes every step comes back as `found`. */
export async function evaluate(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanInput,
  waive: Waive = {},
): Promise<Evaluated> {
  if (
    actor.principal === 'scanner' &&
    actor.templateIds.length === 0 &&
    !actor.settings.acceptAllTemplates
  )
    return stop('refused', 'not_accepted');
  const all = await findCandidates(ctx, actor, input);
  const first = all[0];
  if (!first) return stop('refused', 'not_found');
  const inMode = all.filter((c) => c.pass.mode === actor.mode);
  const other = inMode[0] ?? first;
  if (inMode.length === 0) {
    const ref = (await foundOf(ctx, first))?.ref ?? null;
    return stop('refused', actor.mode === 'live' ? 'test_pass' : 'live_pass', {
      pass: first.pass,
      ref,
    });
  }
  const accepted = inMode.filter((c) => accepts(actor, c.pass));
  if (accepted.length === 0) {
    const ref = (await foundOf(ctx, other))?.ref ?? null;
    return stop('refused', 'not_accepted', { pass: other.pass, ref });
  }
  const matched = accepted.filter((c) => matchesEvent(actor, c.pass));
  const one = matched[0];
  if (!one) return stop('refused', 'wrong_event', { pass: accepted[0]?.pass ?? null });
  if (matched.length > 1) return stop('refused', 'ambiguous');
  const found = await foundOf(ctx, one, actor);
  if (!found) return stop('refused', 'not_accepted', { pass: one.pass });
  const known = { pass: found.pass, ref: found.ref, found };
  const configured =
    Object.keys(found.checkInRules ?? {}).length > 0 ||
    Object.keys(actor.settings.checkIn ?? {}).length > 0 ||
    actor.settings.direction === 'out' ||
    actor.settings.direction === 'both';
  const admission = configured ? await planAdmission(ctx, actor, found, waive.direction) : null;
  found.admission = admission?.plan;
  const exiting = admission?.plan.state.direction === 'out';

  const now = ctx.clock.now();
  if (found.pass.removedAt !== null)
    return stop('refused', 'removed', { ...known, at: found.pass.removedAt });
  const validity = validityOf(found.passJson, now);
  if (found.pass.status === 'voided' || validity.status === 'voided')
    return stop('refused', 'voided', { ...known, at: found.pass.modifiedAt });
  if (validity.status === 'expired' && !exiting)
    return stop('refused', 'expired', { ...known, at: validity.validUntil });
  if (admission?.reason)
    return stop(
      admission.reason === 'not_accepted' || admission.reason === 'wrong_event'
        ? 'refused'
        : 'heads_up',
      admission.reason,
      { ...known, at: admission.at, flags: admission.flags, hard: true },
    );
  const held = exiting ? null : windowStop(actor, found, now, waive);
  if (held) return held;
  const flagged = activeFlags(found).filter((f) => f.stop);
  if (flagged.length > 0 && !waive.confirmed)
    return stop('heads_up', 'check_required', { ...known, flags: flagged.map((f) => f.label) });
  return { stop: false, found };
}
