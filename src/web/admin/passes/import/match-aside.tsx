import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { FormField, IconButton, Input, Select, SwitchRow } from '../../../ui/index.ts';
import type { FormValues } from '../schema-form/index.ts';
import { InputCard } from './input-card.tsx';
import { findable, type MatchState } from './match-model.ts';
import { previewInput, sampleRowsOf } from './match-sample.ts';

/** A sample row of the file as the template's card: first rows, stepped with the arrows. */
export function RowCard({
  imp,
  orgId,
  principalId,
  state,
}: {
  imp: PassImportDto;
  orgId: string;
  principalId: string | undefined;
  state: MatchState;
}) {
  const [at, setAt] = useState(0);
  const n = sampleRowsOf(imp.columns);
  const i = Math.min(at, n - 1);
  return (
    <section aria-label={C.match.rowCard} className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg-strong">{C.match.row(i + 2)}</h3>
        <div className="flex">
          <IconButton
            size="sm"
            label={C.match.prevRow}
            icon={<ChevronLeft aria-hidden />}
            disabled={i === 0}
            onClick={() => setAt(i - 1)}
          />
          <IconButton
            size="sm"
            label={C.match.nextRow}
            icon={<ChevronRight aria-hidden />}
            disabled={i >= n - 1}
            onClick={() => setAt(i + 1)}
          />
        </div>
      </div>
      <div className="mx-auto w-full max-w-60">
        <InputCard
          imp={imp}
          orgId={orgId}
          principalId={principalId}
          input={previewInput(state, imp.columns, i) as FormValues}
        />
      </div>
    </section>
  );
}

export interface MatchSettingsValue {
  save: boolean;
  name: string;
  keepManual: boolean;
}

/** How passes are found, whether edits are kept, and the mapping's name. */
export function MatchSettings({
  state,
  value,
  onState,
  onValue,
  matchError,
}: {
  state: MatchState;
  value: MatchSettingsValue;
  onState: (s: MatchState) => void;
  onValue: (v: MatchSettingsValue) => void;
  matchError?: string | undefined;
}) {
  const emailMapped = (state.rows.find((r) => r.role === 'holderEmail')?.from.length ?? 0) > 0;
  const options = [
    ...findable(state).map((r) => ({ value: `col:${r.key}`, label: C.match.updateWhen(r.label) })),
    ...(emailMapped ? [{ value: 'email', label: C.match.updateEmail }] : []),
    { value: 'none', label: C.match.alwaysNew },
  ];
  // A choice that no longer has a column falls back to its label until the admin picks again.
  const known = options.some((o) => o.value === state.find);
  return (
    <div className="flex flex-col gap-4">
      <SwitchRow
        label={C.match.rememberAs}
        checked={value.save}
        onCheckedChange={(save) => onValue({ ...value, save })}
      />
      {value.save ? (
        <FormField label={C.match.mappingName}>
          {(c) => (
            <Input
              {...c}
              value={value.name}
              maxLength={60}
              placeholder={C.match.namePlaceholder}
              onChange={(e) => onValue({ ...value, name: e.target.value })}
            />
          )}
        </FormField>
      ) : null}
      <FormField label={C.match.existing} error={matchError}>
        {(c) => (
          <Select
            {...c}
            value={known ? state.find : undefined}
            placeholder={C.match.choose}
            onValueChange={(find) => onState({ ...state, find })}
            options={options}
          />
        )}
      </FormField>
      {state.find === 'none' ? null : (
        <SwitchRow
          label={C.match.keepManual}
          checked={value.keepManual}
          onCheckedChange={(keepManual) => onValue({ ...value, keepManual })}
        />
      )}
    </div>
  );
}
