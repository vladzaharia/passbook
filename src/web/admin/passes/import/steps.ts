import type { WizardStepDef } from '../../../ui/index.ts';

export const IMPORT_STEPS = [
  { id: 'source', title: 'Source', heading: 'Add the file' },
  { id: 'match', title: 'Match', heading: 'Match the columns' },
  { id: 'check', title: 'Check', heading: 'Check the rows' },
  { id: 'issue', title: 'Issue', heading: 'Issue the passes' },
] as const satisfies readonly WizardStepDef[];

export const STEP = { source: 0, match: 1, check: 2, issue: 3 } as const;

/** What the rail says under a step that is done. */
export interface ImportSummary {
  source?: string | undefined;
  match?: string | undefined;
  check?: string | undefined;
}

export function importSteps(summary: ImportSummary = {}): WizardStepDef[] {
  return IMPORT_STEPS.map((s) => ({
    ...s,
    summary: s.id === 'issue' ? undefined : summary[s.id],
  }));
}
