import { useState } from 'react';
import type { EntitlementItemDto } from '@/shared/contracts/entitlement-admin.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import { DateTimeField, type DateTimeValue } from '@/web/ui/date-time-field.tsx';
import { FormDialog, FormField, Input, useFormErrors } from '@/web/ui/index.ts';
import { isoToLocal, localToIso } from '../../passes/schema-form/datetime.ts';
import { draftOf, type ValueDraft, ValueField, valueFromDraft } from './value-field.tsx';
import { formatValue, type OverrideDraft } from './values.ts';

const NOTE_MAX = 200;

/**
 * Sets one feature by hand, with a note for the next admin and an optional expiry. Continue hands the
 * override to the page, which shows its impact and asks before saving.
 */
export function OverrideDialog({
  item,
  presetLabel,
  now,
  timeZone,
  onClose,
  onContinue,
}: {
  item: EntitlementItemDto;
  presetLabel: string;
  now: number;
  /** The org's zone: an expiry reads and saves in it. */
  timeZone: string;
  onClose: () => void;
  onContinue: (draft: OverrideDraft) => void;
}) {
  const key = item.key;
  const label = ENTITLEMENT_LABEL[key];
  const zone = timeZone;
  const [value, setValue] = useState<ValueDraft>(() => draftOf(key, item.value));
  const [note, setNote] = useState(item.note ?? '');
  const [expires, setExpires] = useState<DateTimeValue | null>(
    item.expiresAt
      ? { local: isoToLocal(new Date(item.expiresAt).toISOString(), zone), zone }
      : null,
  );
  const parsed = valueFromDraft(key, value);
  const expiresAt = expires?.local
    ? Date.parse(localToIso(expires.local, expires.zone) ?? '')
    : null;
  const check = useFormErrors({
    value: 'error' in parsed ? parsed.error : undefined,
    expires:
      expires && (expiresAt === null || Number.isNaN(expiresAt) || expiresAt <= now)
        ? 'Choose a time in the future.'
        : undefined,
  });
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Override ${label}`}
      description={`Replaces the ${presetLabel} value, ${formatValue(key, item.presetValue)}.`}
      dirty
      check={check}
      submitLabel="Continue"
      onSubmit={() => {
        if ('error' in parsed) return;
        onContinue({
          value: parsed.value,
          note: note.trim() || null,
          expiresAt: expires && expiresAt !== null ? expiresAt : null,
        });
      }}
    >
      <ValueField featureKey={key} draft={value} onChange={setValue} error={check.errors.value} />
      <FormField label="Note" help="Why. Only platform admins see it.">
        {(p) => (
          <Input
            {...p}
            maxLength={NOTE_MAX}
            autoComplete="off"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Expires" error={check.errors.expires}>
        {(p) => (
          <DateTimeField
            {...p}
            value={expires}
            onChange={setExpires}
            clearLabel="Never expires"
            defaultZone={zone}
          />
        )}
      </FormField>
    </FormDialog>
  );
}
