import {
  Button,
  DependentSettings,
  FormField,
  FormGrid,
  Input,
  NumberField,
  SwitchRow,
} from '@/web/ui/index.ts';
import { nameSuggestions, whereOf } from '../draft.ts';
import { AreaTree } from './area-tree.tsx';
import type { StepProps } from './step-props.ts';

/** Door name, with chips for the usual names. */
function DoorName({ draft, set }: Pick<StepProps, 'draft' | 'set'>) {
  return (
    <div className="grid gap-2">
      <FormField label="Door name" required>
        {(c) => (
          <Input
            {...c}
            value={draft.name}
            maxLength={80}
            autoComplete="off"
            onChange={(e) => set({ name: e.target.value })}
          />
        )}
      </FormField>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Suggested names</legend>
        {nameSuggestions(draft.preset).map((n) => (
          <Button
            key={n}
            size="sm"
            variant="outline"
            className="rounded-full"
            aria-pressed={draft.name === n}
            onClick={() => set({ name: n })}
          >
            {n}
          </Button>
        ))}
      </fieldset>
    </div>
  );
}

/** Where: the door, and what it counts. The rest changes with the preset. */
export function WhereStep({ draft, set }: StepProps) {
  return (
    <div className="grid gap-6">
      <DoorName draft={draft} set={set} />
      {whereOf(draft.preset) === 'count' ? (
        <div className="grid gap-4 rounded-lg border border-border bg-surface-raised p-4">
          <SwitchRow
            label="Count who's inside"
            checked={draft.count}
            onCheckedChange={(count) => set({ count })}
          />
          <DependentSettings open={draft.count}>
            <FormGrid className="@[40rem]:grid-cols-2">
              <FormField label="Area" required>
                {(c) => (
                  <Input
                    {...c}
                    value={draft.area}
                    maxLength={40}
                    autoComplete="off"
                    onChange={(e) => set({ area: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label="Max inside">
                {(c) => (
                  <NumberField
                    {...c}
                    min={1}
                    className="w-full"
                    value={draft.max === '' ? null : Number(draft.max)}
                    onValueChange={(v) => set({ max: v === null ? '' : String(v) })}
                  />
                )}
              </FormField>
            </FormGrid>
          </DependentSettings>
        </div>
      ) : null}
      {whereOf(draft.preset) === 'areas' ? (
        <AreaTree
          areas={draft.areas}
          doorArea={draft.doorArea}
          onChange={(areas, doorArea) => set({ areas, doorArea })}
        />
      ) : null}
    </div>
  );
}
