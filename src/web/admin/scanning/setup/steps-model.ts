import type { WizardStepDef } from '@/web/ui/index.ts';
import { type Draft, eventCount, STEPS, type StepId, skipsWhen, stepProblem } from './draft.ts';
import type { SummaryLine } from './summary.ts';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The rail: headings, what each done step chose, and Event doors skipping When. */
export function setupSteps(d: Draft, lines: readonly SummaryLine[]): WizardStepDef<StepId>[] {
  const line = (key: SummaryLine['key']) => lines.find((l) => l.key === key)?.value ?? undefined;
  const summary: Partial<Record<StepId, string | undefined>> = {
    where: d.name.trim() || undefined,
    admits: d.any ? 'Any pass type' : plural(d.templateIds.length + eventCount(d), 'pass type'),
    when: line('when'),
    scanners: line('scanners'),
    devices: line('devices'),
  };
  return STEPS.map((s) => ({
    ...s,
    summary: summary[s.id],
    skip: s.id === 'when' && skipsWhen(d),
  }));
}

/** What blocks each step, a pure function of the answers; Review's comes from the plan check. */
export function setupErrors(d: Draft, review: string | undefined) {
  const out: Partial<Record<StepId, Record<string, string>>> = {};
  for (const s of STEPS) {
    const why = s.id === 'review' ? review : stepProblem(d, s.id);
    if (why) out[s.id] = { [s.id]: why };
  }
  return out;
}
