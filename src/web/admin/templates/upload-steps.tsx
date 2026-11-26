import { StepList, type StepListItem } from '../../ui/index.ts';

const ORDER = ['queued', 'extract', 'analyze', 'dry-run', 'persist'] as const;
const TEXT: Record<(typeof ORDER)[number], string> = {
  queued: 'Waiting to start',
  extract: 'Opening the package',
  analyze: 'Checking files and images',
  'dry-run': 'Building a sample pass',
  persist: 'Saving the template',
};

/** Where the server is in the import: `step` is its own word, unknown ones count as the first. */
export function uploadStepIndex(step: string | null | undefined) {
  if (step === 'done') return ORDER.length - 1;
  const i = ORDER.indexOf((step ?? 'queued') as (typeof ORDER)[number]);
  return Math.max(i, 0);
}

export function uploadStepText(step: string | null | undefined) {
  return TEXT[ORDER[uploadStepIndex(step)] ?? 'queued'];
}

/** The import's stages as a list: done, the one running (or failed), and what is left. */
export function UploadSteps({
  step,
  failed,
}: {
  step: string | null | undefined;
  failed: boolean;
}) {
  const at = uploadStepIndex(step);
  const items: StepListItem[] = ORDER.map((id, i) => ({
    id,
    label: TEXT[id],
    state: i < at ? 'done' : i === at ? (failed ? 'failed' : 'working') : 'todo',
  }));
  return <StepList label="Import progress" items={items} />;
}
