import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { RotateTagKeysetSchema } from '@/shared/contracts/nfc-tag-keysets.ts';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { FormDialog, SecretReveal, toast, useFormErrors } from '@/web/ui/index.ts';
import type { Keyset, MadeKeyset } from './api.ts';
import { KeyInputs, ModeTiles, useKeyDraft } from './key-fields.tsx';
import { SdmProfile } from './sdm-profile.tsx';

/** New keys for a keyset: generated and shown once, or entered. Imported-tag keysets take the meta key. */
export function RotateDialog({
  keyset,
  rotate,
  onClose,
}: {
  keyset: Keyset;
  rotate: (id: string, body: z.infer<typeof RotateTagKeysetSchema>) => Promise<MadeKeyset>;
  onClose: () => void;
}) {
  const modes = keyset.perTag ? (['own'] as const) : (['generate', 'enter'] as const);
  const draft = useKeyDraft(modes[0]);
  const [made, setMade] = useState<MadeKeyset>();
  const { meta, file } = draft.trimmed;
  const body =
    draft.mode === 'generate'
      ? { generate: true }
      : draft.mode === 'own'
        ? { metaKey: meta }
        : { metaKey: meta, fileKey: file };
  const check = useFormErrors({
    keys:
      draft.mode === 'generate' || RotateTagKeysetSchema.safeParse(body).success
        ? undefined
        : 'A key is 32 hex digits.',
  });

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Rotate keys of ${keyset.name}`}
      description={KEYSET_COPY.help}
      dirty={draft.dirty}
      check={check}
      submitLabel="Rotate keys"
      onSubmit={async () => {
        const result = await rotate(keyset.id, body as z.infer<typeof RotateTagKeysetSchema>);
        if (result.keys) setMade(result);
        else {
          toast.success(KEYSET_COPY.entered);
          onClose();
        }
      }}
      result={
        made?.keys
          ? {
              title: `Keys of ${made.name}`,
              icon: <KeyRound aria-hidden />,
              body: (
                <SecretReveal
                  savedLabel="I saved the keys"
                  onDone={onClose}
                  fields={[
                    { label: 'Meta key', value: made.keys.metaKey },
                    { label: 'File key', value: made.keys.fileKey, sheen: false },
                  ]}
                >
                  <SdmProfile keyset={made} />
                </SecretReveal>
              ),
            }
          : undefined
      }
    >
      {modes.length > 1 ? <ModeTiles modes={modes} draft={draft} /> : null}
      <KeyInputs draft={draft} error={check.errors.keys} diversifyChoice={false} />
    </FormDialog>
  );
}
