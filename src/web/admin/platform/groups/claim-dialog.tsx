import { useState } from 'react';
import { type ClaimType, ClaimValueSchema } from '@/shared/contracts/idp-access.ts';
import { GROUP_COPY } from '@/shared/copy/idp-platform.ts';
import {
  FormDialog,
  FormField,
  Input,
  Select,
  Textarea,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useGroupActions } from './queries.ts';

export interface ClaimDraft {
  key: string;
  type: ClaimType;
  /** Text as typed; json as its source text. */
  raw: string;
}

const KEY = /^passbook_[a-z0-9_]{1,48}$/;
const TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'json', label: 'JSON' },
];

/** What the typed text means for a type: the value, or why it is not one. */
export function claimValueOf(
  type: ClaimType,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let value: unknown = raw;
  if (type === 'number') {
    value = raw.trim() === '' ? Number.NaN : Number(raw);
  } else if (type === 'boolean') {
    value = raw === 'true';
  } else if (type === 'json') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Not valid JSON.' };
    }
  }
  const parsed = ClaimValueSchema.safeParse({ type, value });
  return parsed.success
    ? { ok: true, value }
    : { ok: false, error: parsed.error.issues[0]?.message ?? 'Not a valid value.' };
}

/** Text form of a stored value, for editing. */
export const rawOf = (type: ClaimType, value: unknown): string =>
  type === 'json' ? JSON.stringify(value, null, 2) : String(value ?? '');

/** Add or change one claim on a group. Edit keeps the key. */
export function ClaimDialog({
  groupKey,
  draft,
  editing,
  onClose,
}: {
  groupKey: string;
  /** null closes the dialog. */
  draft: ClaimDraft | null;
  editing: boolean;
  onClose: () => void;
}) {
  const { setClaims } = useGroupActions();
  const [edit, setEdit] = useState<Partial<ClaimDraft>>({});
  const open = draft !== null;
  const key = edit.key ?? draft?.key ?? '';
  const type = edit.type ?? draft?.type ?? 'text';
  const raw = edit.raw ?? draft?.raw ?? (type === 'boolean' ? 'true' : '');
  const value = claimValueOf(type, raw);
  const check = useFormErrors({
    ...(KEY.test(key) ? {} : { key: 'Start with passbook_, then letters, digits or _.' }),
    ...(value.ok ? {} : { value: value.error }),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={editing ? 'Edit claim' : 'Add claim'}
      size="sm"
      dirty={Object.keys(edit).length > 0}
      check={check}
      submitLabel={editing ? 'Save claim' : 'Add claim'}
      busy={setClaims.isPending}
      onClose={() => setEdit({})}
      onSubmit={async () => {
        if (!value.ok) return;
        const sent = await setClaims.mutateAsync({
          key: groupKey,
          change: { set: { [key]: { type, value: value.value } as never } },
        });
        toast.success(sent.dryRun ? GROUP_COPY.dryRun : 'Claim saved');
        onClose();
      }}
    >
      {({ errors }) => (
        <>
          <FormField label="Key" required error={check.errors.key ?? errors.set}>
            {(control) => (
              <Input
                {...control}
                data-autofocus={editing ? undefined : ''}
                readOnly={editing}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="passbook_plan"
                value={key}
                onChange={(event) =>
                  setEdit((e) => ({ ...e, key: event.target.value.toLowerCase() }))
                }
              />
            )}
          </FormField>
          <FormField label="Type">
            {(control) => (
              <Select
                {...control}
                options={TYPES}
                value={type}
                onValueChange={(next) =>
                  setEdit((e) => ({
                    ...e,
                    type: next as ClaimType,
                    raw: next === 'boolean' ? 'true' : '',
                  }))
                }
              />
            )}
          </FormField>
          <FormField label="Value" required error={check.errors.value} help={GROUP_COPY.claims}>
            {(control) =>
              type === 'boolean' ? (
                <Select
                  {...control}
                  options={[
                    { value: 'true', label: 'Yes' },
                    { value: 'false', label: 'No' },
                  ]}
                  value={raw}
                  onValueChange={(next) => setEdit((e) => ({ ...e, raw: next }))}
                />
              ) : type === 'json' ? (
                <Textarea
                  {...control}
                  spellCheck={false}
                  className="font-mono"
                  rows={5}
                  value={raw}
                  onChange={(event) => setEdit((e) => ({ ...e, raw: event.target.value }))}
                />
              ) : (
                <Input
                  {...control}
                  autoComplete="off"
                  inputMode={type === 'number' ? 'decimal' : undefined}
                  value={raw}
                  onChange={(event) => setEdit((e) => ({ ...e, raw: event.target.value }))}
                />
              )
            }
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
