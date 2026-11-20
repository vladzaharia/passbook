import type { Personalization } from '../../../passkit/types.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import type { TemplateCandidate } from './repo.ts';

interface Manifest {
  inputs?: { properties?: Record<string, unknown> };
  scan?: unknown;
}

/** The guest plan a template's visitors take, and the inputs it names for their window and host. */
export function guestPlanOf(manifest: unknown) {
  const m = manifest as Parameters<typeof scanOf>[0];
  const access = scanOf(m).access;
  const plan = access?.plans.find((p) => p.kind === 'guest');
  return access && plan ? { access, plan } : null;
}

function parse(c: TemplateCandidate): Manifest | null {
  try {
    return JSON.parse(c.manifest) as Manifest;
  } catch {
    return null;
  }
}

/** Templates that take visitors: an access plan of the guest kind. */
export function visitorTemplates(candidates: TemplateCandidate[]) {
  return candidates.flatMap((c) => {
    const manifest = parse(c);
    return manifest && guestPlanOf(manifest) ? [{ id: c.id, name: c.name, manifest }] : [];
  });
}

export interface VisitorInputFacts {
  name: string;
  hostName: string;
  windowFrom: number;
  note: string | null;
  /** A short pass ID the template's lookup shows on the pass. */
  code: string;
}

/** The pass inputs for a visitor, for the inputs this template has: the others are left out. */
export function visitorInput(manifest: Manifest, f: VisitorInputFacts): Personalization | null {
  const has = (key: string | undefined): key is string =>
    key !== undefined && manifest.inputs?.properties?.[key] !== undefined;
  const found = guestPlanOf(manifest);
  if (!found || !has('memberName')) return null;
  const { access, plan } = found;
  const input: Personalization = { memberName: f.name };
  if (has('memberId')) input.memberId = f.code;
  const names = access.input;
  // An access card is valid only on one of its plans, so the guest plan is always named.
  input[names.plan] = plan.id;
  if (has(names.from)) input[names.from] = new Date(f.windowFrom).toISOString();
  if (has(names.sponsor)) input[names.sponsor] = f.hostName;
  if (f.note && has('note')) input.note = f.note;
  return input;
}
