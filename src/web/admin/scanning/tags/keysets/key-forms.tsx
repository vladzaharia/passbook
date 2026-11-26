import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { CreateTagKeysetSchema } from '@/shared/contracts/nfc-tags.ts';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import {
  FormField,
  Input,
  SecretReveal,
  toast,
  useWizard,
  WizardDialog,
  WizardReview,
} from '@/web/ui/index.ts';
import type { MadeKeyset } from './api.ts';
import { KeyInputs, ModeTiles, useKeyDraft } from './key-fields.tsx';
import { SdmProfile } from './sdm-profile.tsx';

type Body = z.infer<typeof CreateTagKeysetSchema>;
const C = KEYSET_COPY.mode;
const MODE_LABEL = { generate: C.generate, enter: C.enter, own: C.own } as const;
const MODES = ['generate', 'enter', 'own'] as const;
const HINTS = { keyset: 'Name the keyset.', keys: 'Fix the keys.' };
const FIELD_STEP = {
  name: 'keyset',
  generate: 'keyset',
  metaKey: 'keys',
  fileKey: 'keys',
  diversify: 'keys',
  perTag: 'keys',
} as const;

/** A keyset in three steps: its name and how its keys come, the keys (not for Generate), Review. */
export function NewKeysetDialog({
  create,
  onClose,
}: {
  create: (body: Body) => Promise<MadeKeyset>;
  onClose: () => void;
}) {
  const draft = useKeyDraft('generate');
  const [name, setName] = useState('');
  const [made, setMade] = useState<MadeKeyset>();
  const { meta, file } = draft.trimmed;
  const body: Body =
    draft.mode === 'generate'
      ? { name: name.trim(), generate: true, diversify: true }
      : draft.mode === 'own'
        ? { name: name.trim(), perTag: true, metaKey: meta }
        : { name: name.trim(), diversify: draft.diversify, metaKey: meta, fileKey: file };
  const keysOk = draft.mode === 'generate' || CreateTagKeysetSchema.safeParse(body).success;
  const generate = draft.mode === 'generate';

  const w = useWizard({
    open: true,
    steps: [
      {
        id: 'keyset',
        title: 'Keyset',
        heading: 'Name the keyset',
        summary: name.trim() || undefined,
      },
      { id: 'keys', title: 'Keys', heading: 'Enter the keys', skip: generate },
      { id: 'review', title: 'Review', heading: 'Check and create' },
    ],
    errors: {
      keyset: name.trim() ? undefined : { name: 'Enter a name.' },
      keys: keysOk ? undefined : { keys: 'A key is 32 hex digits.' },
    },
    hints: HINTS,
    fieldStep: FIELD_STEP,
    onFinish: async () => {
      const result = await create(body);
      if (result.keys) setMade(result);
      else {
        toast.success(KEYSET_COPY.entered);
        onClose();
      }
    },
  });

  return (
    <WizardDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={KEYSET_COPY.add}
      wizard={w}
      dirty={name !== '' || draft.dirty}
      finishLabel="Create keyset"
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
      {w.id === 'keyset' ? (
        <>
          <FormField label="Name" required error={w.errors.name}>
            {(props) => (
              <Input
                {...props}
                data-autofocus
                value={name}
                maxLength={40}
                placeholder="Staff badges"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <ModeTiles modes={MODES} draft={draft} />
        </>
      ) : null}
      {w.id === 'keys' ? (
        <KeyInputs draft={draft} error={w.errors.keys} diversifyChoice autoFocus />
      ) : null}
      {w.id === 'review' ? (
        <WizardReview
          onEdit={w.go}
          {...(generate ? { note: 'The keys are shown once, after you create it.' } : {})}
          sections={[
            {
              id: 'keyset',
              title: 'Keyset',
              items: [
                { label: 'Name', value: name.trim() },
                { label: 'Keys', value: MODE_LABEL[draft.mode] },
              ],
            },
            ...(generate
              ? []
              : [
                  {
                    id: 'keys' as const,
                    title: 'Keys',
                    items: [
                      { label: 'Meta key', value: 'Entered' },
                      ...(draft.mode === 'enter'
                        ? [
                            { label: 'File key', value: 'Entered' },
                            { label: 'Key per tag', value: draft.diversify ? 'Yes' : 'No' },
                          ]
                        : []),
                    ],
                  },
                ]),
          ]}
        />
      ) : null}
    </WizardDialog>
  );
}
