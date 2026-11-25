import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { type FormValues, SchemaForm } from '../../passes/schema-form/index.ts';
import { DatasetPicker } from './dataset-picker.tsx';
import { DEFAULT_DATASET, datasetOf } from './datasets.ts';

type Obj = Record<string, unknown>;

const MAIN = ['locale', 'count', 'seed', 'holderDomain'];
const CHANGES = ['anchor', 'revision', 'changeRate'];
const FAILURES = ['fail', 'missing'];

function Fold({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="group min-w-0" open={open || undefined}>
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm text-sm font-medium text-fg hover:text-fg-strong pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 text-fg-muted motion-safe:transition-transform motion-safe:duration-(--wl-dur-enter) group-open:rotate-90"
        />
        {title}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

/**
 * The Demo connector's Configuration: pick a dataset, then the few knobs people reach for.
 * Changing the dataset is the signal for the wizard to run Test.
 */
export function DemoFields({
  schema,
  value,
  onChange,
  showErrors,
  serverErrors,
}: {
  schema: Obj | undefined;
  value: FormValues;
  onChange: (next: FormValues) => void;
  showErrors: boolean;
  serverErrors: Record<string, string> | undefined;
}) {
  const dataset = typeof value.dataset === 'string' ? value.dataset : undefined;
  // A new demo starts on the first blueprint's dataset, not the plain one.
  useEffect(() => {
    if (!dataset) onChange({ ...value, dataset: DEFAULT_DATASET });
  }, [dataset, value, onChange]);
  const current = dataset ?? DEFAULT_DATASET;
  const props = (schema?.properties ?? {}) as Record<string, Obj>;
  const keys = Object.keys(props);
  const noun = datasetOf(current)?.noun ?? 'Records';
  const labelled = {
    ...schema,
    properties: {
      ...props,
      count: { ...props.count, 'x-label': noun },
      seed: { ...props.seed, 'x-placeholder': 'demo' },
    },
  };
  const failed = (show: readonly string[]) => show.some((k) => serverErrors?.[k]);
  const part = (show: readonly string[], idPrefix: string) => (
    <SchemaForm
      schema={labelled}
      value={value}
      onChange={onChange}
      hiddenKeys={new Set(keys.filter((k) => !show.includes(k)))}
      showAllErrors={showErrors}
      serverErrors={serverErrors}
      idPrefix={idPrefix}
    />
  );
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <DatasetPicker value={current} onPick={(d) => onChange({ ...value, dataset: d })} />
      {part(MAIN, 'demo-')}
      <Fold title="Simulate changes" open={failed(CHANGES)}>
        {part(CHANGES, 'demo-chg-')}
      </Fold>
      <Fold title="Simulate failures" open={failed(FAILURES)}>
        {part(FAILURES, 'demo-fail-')}
      </Fold>
    </div>
  );
}
