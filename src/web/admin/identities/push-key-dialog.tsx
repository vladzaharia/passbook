import { useState } from 'react';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Dialog,
  DialogContent,
  FileDrop,
  Form,
  FormField,
  Input,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import {
  EMPTY_PUSH_DRAFT,
  keyIdFromFilename,
  MAX_P8_BYTES,
  type PushKeyDraft,
  validatePushKey,
} from './push-key-input.ts';
import { useSetPushKey } from './queries.ts';

const FORM_ID = 'push-key';

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
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const check = useFormErrors(validatePushKey(draft));
  const errors = { ...server, ...check.errors } as Record<string, string>;

  function patch(p: Partial<PushKeyDraft>) {
    setDraft((d) => ({ ...d, ...p }));
    setServer({});
  }

  function close() {
    onOpenChange(false);
    setDraft(EMPTY_PUSH_DRAFT);
    setServer({});
    check.reset();
    setFormError(undefined);
  }

  async function submit() {
    setFormError(undefined);
    try {
      await save.mutateAsync({ keyId: draft.keyId.trim(), p8: (await draft.file?.text()) ?? '' });
      toast.success(replacing ? 'Push key replaced' : 'Push key added');
      close();
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      dirty={Boolean(draft.file || draft.keyId)}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        title={replacing ? 'Rotate push key' : 'Add push key'}
        description={`One key serves every identity of team ${team}.`}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} loading={save.isPending}>
              {replacing ? 'Replace key' : 'Add key'}
            </Button>
          </>
        }
      >
        <Form
          id={FORM_ID}
          className="flex flex-col gap-4 overflow-y-auto"
          {...check.form}
          onValid={() => void submit()}
        >
          <div>
            <FileDrop
              art="certificate"
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
          <FormField label="Key ID" required error={errors.keyId}>
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
                onChange={(e) => patch({ keyId: e.target.value.toUpperCase() })}
              />
            )}
          </FormField>
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
