import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Wizard, type WizardProps } from '../../../ui/index.ts';
import { type ImportSummary, importSteps, type STEP } from './steps.ts';

/** What the rail shows under the steps behind `imp`: the file, the rows, the plan. */
export function summaryOf(imp: {
  source: { name: string };
  counts: { rows: number; create: number; update: number } | null;
}): ImportSummary {
  const { counts } = imp;
  return {
    source: imp.source.name,
    match: counts ? C.match.rowsCount(counts.rows) : undefined,
    check: counts ? `${counts.create + counts.update} to issue` : undefined,
  };
}

/**
 * The import's page wizard: the same four steps, headings and summaries on every one of them. Each
 * step is its own state of the import (the file is a page of its own), so the step passes only what
 * its bar needs.
 */
export function ImportWizard({
  current,
  summary,
  ...props
}: Omit<WizardProps, 'steps' | 'states' | 'skipped'> & {
  current: (typeof STEP)[keyof typeof STEP];
  summary?: ImportSummary | undefined;
}) {
  return <Wizard steps={importSteps(summary)} current={current} {...props} />;
}
