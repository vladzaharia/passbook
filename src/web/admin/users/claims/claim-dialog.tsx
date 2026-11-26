import { useState } from 'react';
import {
  CLAIM_VALUE_MAX_BYTES,
  ClaimKeySchema,
  type ClaimType,
  type ClaimValue,
  ClaimValueSchema,
} from '@/shared/contracts/idp-access.ts';
import { IDP_COPY } from '@/shared/copy/idp.ts';
import { FormDialog, FormField, Input, Select, Textarea, useFormErrors } from '@/web/ui/index.ts';

const TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'json', label: 'JSON' },
] as const;

/** The typed value from what was entered; text stays text even when it looks like a number. */
export function parseValue(type: ClaimType, raw: string): ClaimValue | string {
  try {
    const value =
      type === 'text'
        ? raw
        : type === 'number'
          ? Number(raw.trim() === '' ? Number.NaN : raw)
          : type === 'boolean'
            ? raw === 'true'
            : JSON.parse(raw);
    const parsed = ClaimValueSchema.safeParse({ type, value });
    return parsed.success ? parsed.data : (parsed.error.issues[0]?.message ?? 'Not a valid value.');
  } catch {
    return 'Not valid JSON.';
  }
}

/** Add or change one claim. Claims reach every app that signs in with Polaris ID, so the key and type are checked here too. */
export function ClaimDialog({
  open,
  onOpenChange,
  existing,
  current,
  taken,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: string | null;
  current: { type: ClaimType; value: unknown } | undefined;
  taken: readonly string[];
  onSave: (key: string, value: ClaimValue) => Promise<unknown>;
}) {
  // The parent remounts the dialog per target (`key`), so the draft starts from the claim being edited.
  const [key, setKey] = useState(existing ?? '');
  const [type, setType] = useState<ClaimType>(current?.type ?? 'text');
  const [raw, setRaw] = useState(() =>
    current === undefined
      ? ''
      : typeof current.value === 'string'
        ? current.value
        : JSON.stringify(current.value, null, current.type === 'json' ? 2 : 0),
  );

  const parsed = parseValue(type, type === 'boolean' && raw === '' ? 'true' : raw);
  const keyError = !ClaimKeySchema.safeParse(key).success
    ? 'Use letters, digits, _ . : -.'
    : !existing && taken.includes(key)
      ? 'This claim already exists.'
      : undefined;
  const valueError = typeof parsed === 'string' ? parsed : undefined;
  const check = useFormErrors({ key: keyError, value: valueError });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={existing ? 'Change claim' : 'Add claim'}
      description={IDP_COPY.claimsReach}
      submitLabel="Save claim"
      check={check}
      dirty={key !== '' || raw !== ''}
      onSubmit={async () => {
        if (typeof parsed === 'string') return;
        await onSave(key, parsed);
        onOpenChange(false);
      }}
    >
      <div className="flex flex-col gap-4">
        <FormField label="Key" required error={check.errors.key}>
          {(p) => (
            <Input
              {...p}
              data-autofocus
              autoComplete="off"
              readOnly={existing !== null}
              placeholder="department"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Type">
          {(p) => (
            <Select
              {...p}
              value={type}
              onValueChange={(next) => {
                setType(next as ClaimType);
                setRaw(next === 'boolean' ? 'true' : '');
              }}
              options={TYPES}
            />
          )}
        </FormField>
        <FormField label="Value" required error={check.errors.value}>
          {(p) =>
            type === 'boolean' ? (
              <Select
                {...p}
                value={raw === 'false' ? 'false' : 'true'}
                onValueChange={setRaw}
                options={[
                  { value: 'true', label: 'True' },
                  { value: 'false', label: 'False' },
                ]}
              />
            ) : type === 'json' ? (
              <Textarea
                {...p}
                rows={5}
                spellCheck={false}
                className="font-mono"
                maxLength={CLAIM_VALUE_MAX_BYTES}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
              />
            ) : (
              <Input
                {...p}
                autoComplete="off"
                inputMode={type === 'number' ? 'decimal' : undefined}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
              />
            )
          }
        </FormField>
      </div>
    </FormDialog>
  );
}
