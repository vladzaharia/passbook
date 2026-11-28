import { Mail } from 'lucide-react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { FormField, Select, SwitchRow } from '../../../ui/index.ts';
import { HOLD_CHOICES } from './api-run.ts';

export interface EmailChoice {
  on: boolean;
  hold: (typeof HOLD_CHOICES)[number]['value'];
}

/** Whether new holders are emailed, and when: the wait is the window to undo. */
export function EmailSettings({
  imp,
  value,
  onChange,
}: {
  imp: PassImportDto;
  value: EmailChoice;
  onChange: (v: EmailChoice) => void;
}) {
  const counts = imp.counts;
  if (!counts) return null;
  const budget = imp.emailBudget ?? 0;
  const canEmail = counts.emailable > 0 && budget > 0;
  const on = value.on && canEmail;
  return (
    <div className="flex flex-col gap-4">
      <SwitchRow
        label={C.sheet.email}
        checked={on}
        disabled={!canEmail}
        onCheckedChange={(next) => onChange({ ...value, on: next })}
      />
      {on ? (
        <>
          <FormField label={C.check.send}>
            {(c) => (
              <Select
                {...c}
                value={value.hold}
                onValueChange={(hold) => onChange({ ...value, hold: hold as EmailChoice['hold'] })}
                options={HOLD_CHOICES.map((h) => ({ value: h.value, label: h.label }))}
              />
            )}
          </FormField>
          <p className="flex items-center gap-2 text-xs text-fg-muted">
            <Mail aria-hidden className="size-3.5" />
            {C.check.emailLine(counts.emailable, budget)}
          </p>
        </>
      ) : null}
    </div>
  );
}
