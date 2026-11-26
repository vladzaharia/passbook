import { OptionTile } from '../../../ui/index.ts';
import { DEMO_DATASETS } from './datasets.ts';

/** Nine datasets, each a blueprint's worth of coherent records. */
export function DatasetPicker({
  value,
  onPick,
}: {
  value: string;
  onPick: (dataset: string) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-fg">Dataset</legend>
      <div
        role="radiogroup"
        aria-label="Dataset"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
      >
        {DEMO_DATASETS.map((d) => (
          <OptionTile
            key={d.id}
            name="demo-dataset"
            value={d.id}
            label={d.label}
            description={d.blurb}
            icon={d.icon}
            checked={d.id === value}
            onSelect={onPick}
          />
        ))}
      </div>
    </fieldset>
  );
}
