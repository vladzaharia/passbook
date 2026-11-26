import { useState } from 'react';
import { FileDrop, FormDialog, FormField, Input, toast, useFormErrors } from '@/web/ui/index.ts';
import {
  EMPTY_PUSH_DRAFT,
  keyIdFromFilename,
  MAX_P8_BYTES,
  type PushKeyDraft,
  validatePushKey,
} from './push-key-input.ts';
import { useSetPushKey } from './queries.ts';

/** Adds or replaces the APNs key of the identity's team. The team comes from the identity. */
export function PushKeyDialog({
  identityId,
  team,
  replacing,
  open,
  onOpenChange,
}: {
  identityId: string;
  team: string;
  replacing: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSetPushKey(identityId);
  const [draft, setDraft] = useState<PushKeyDraft>(EMPTY_PUSH_DRAFT);
  const check = useFormErrors(validatePushKey(draft));

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={replacing ? 'Replace push key' : 'Add push key'}
      description={`One key serves every identity of team ${team}.`}
      dirty={Boolean(draft.file || draft.keyId)}
      check={check}
      submitLabel={replacing ? 'Replace key' : 'Add key'}
      busy={save.isPending}
      onSubmit={async () => {
        await save.mutateAsync({ keyId: draft.keyId.trim(), p8: (await draft.file?.text()) ?? '' });
        toast.success(replacing ? 'Push key replaced' : 'Push key added');
        onOpenChange(false);
      }}
      onClose={() => setDraft(EMPTY_PUSH_DRAFT)}
    >
      {({ errors: server, clear }) => {
        const errors = { ...server, ...check.errors } as Record<string, string | undefined>;
        const patch = (p: Partial<PushKeyDraft>) => {
          setDraft((d) => ({ ...d, ...p }));
          clear();
        };
        return (
          <>
            <div>
              <FileDrop
                autoFocus
                art="key"
                className="[--art-a:var(--pk-info)]"
                accept=".p8"
                maxBytes={MAX_P8_BYTES}
                label={draft.file ? draft.file.name : 'Choose the AuthKey .p8 file'}
                invalid={Boolean(errors.p8)}
                onFiles={([file]) =>
                  patch({
                    file,
                    keyId: draft.keyId || keyIdFromFilename(file?.name ?? ''),
                  })
                }
              />
              {errors.p8 ? (
                <p role="alert" className="mt-1.5 text-xs text-danger">
                  {errors.p8}
                </p>
              ) : null}
            </div>
            <FormField
              label="Key ID"
              required
              error={errors.keyId}
              help="10 letters and digits, from the .p8 file name"
            >
              {(p) => (
                <Input
                  {...p}
                  className="font-mono"
                  placeholder="AB12CD34EF"
                  maxLength={10}
                  spellCheck={false}
                  autoCapitalize="characters"
                  autoComplete="off"
                  value={draft.keyId}
                  onChange={(e) =>
                    patch({ keyId: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })
                  }
                />
              )}
            </FormField>
          </>
        );
      }}
    </FormDialog>
  );
}
