import { KeyRound, ShieldCheck, Upload } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { z } from 'zod';
import { RotateTagKeysetSchema } from '@/shared/contracts/nfc-tag-keysets.ts';
import { CreateTagKeysetSchema } from '@/shared/contracts/nfc-tags.ts';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  CheckboxField,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  OptionTile,
  SecretReveal,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import type { Keyset, MadeKeyset } from './api.ts';
import { SdmProfile } from './sdm-profile.tsx';

type Mode = 'generate' | 'enter' | 'own';
const C = KEYSET_COPY.mode;
const MODES = [
  { value: 'generate', label: C.generate, description: C.generateHelp, icon: ShieldCheck },
  { value: 'enter', label: C.enter, description: C.enterHelp, icon: KeyRound },
  { value: 'own', label: C.own, description: C.ownHelp, icon: Upload },
] as const;

const keyInput = { autoComplete: 'off', autoCapitalize: 'off', spellCheck: false } as const;

/** Create or rotate: keys generated and shown once, entered, or (imported tags) the meta key only. */
function KeysDialog({
  title,
  confirm,
  modes,
  nameField,
  build,
  send,
  onClose,
}: {
  title: string;
  confirm: string;
  modes: readonly Mode[];
  nameField: boolean;
  build: (v: {
    name: string;
    mode: Mode;
    meta: string;
    file: string;
    diversify: boolean;
  }) => unknown;
  send: (body: never) => Promise<MadeKeyset>;
  onClose: () => void;
}) {
  const formId = useId();
  const group = useId();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Mode>(modes[0] ?? 'generate');
  const [meta, setMeta] = useState('');
  const [file, setFile] = useState('');
  const [diversify, setDiversify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<MadeKeyset>();
  const body = build({ name: name.trim(), mode, meta: meta.trim(), file: file.trim(), diversify });
  const ok = nameField
    ? CreateTagKeysetSchema.safeParse(body).success
    : RotateTagKeysetSchema.safeParse(body).success;
  const check = useFormErrors({
    name: nameField && !name.trim() ? 'Enter a name.' : undefined,
    keys: mode === 'generate' || ok ? undefined : 'A key is 32 hex digits.',
  });

  async function save() {
    setBusy(true);
    setError('');
    try {
      const result = await send(body as never);
      if (result.keys) setMade(result);
      else {
        toast.success(KEYSET_COPY.entered);
        onClose();
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && !made && onClose()}>
      <DialogContent
        title={made ? 'Keys' : title}
        description={made ? undefined : 'Keys are stored encrypted and never shown again.'}
        closeButton={!busy && !made}
        footer={
          made ? null : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form={formId} loading={busy}>
                {confirm}
              </Button>
            </>
          )
        }
      >
        {made?.keys ? (
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
        ) : (
          <Form {...check.form} id={formId} className="grid gap-4" onValid={() => void save()}>
            {error ? <Callout tone="danger">{error}</Callout> : null}
            {nameField ? (
              <FormField label="Name" required error={check.errors.name}>
                {(props) => (
                  <Input
                    {...props}
                    value={name}
                    maxLength={40}
                    placeholder="Staff badges"
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </FormField>
            ) : null}
            {modes.length > 1 ? (
              <fieldset className="grid gap-2" disabled={busy}>
                <legend className="mb-2 text-sm font-medium text-fg-strong">Keys</legend>
                {MODES.filter((m) => modes.includes(m.value)).map((m) => (
                  <OptionTile
                    key={m.value}
                    name={group}
                    value={m.value}
                    label={m.label}
                    description={m.description}
                    icon={m.icon}
                    checked={mode === m.value}
                    onSelect={() => setMode(m.value)}
                  />
                ))}
              </fieldset>
            ) : null}
            {mode !== 'generate' ? (
              <>
                <FormField
                  label="Meta key"
                  required
                  help="32 hex digits."
                  error={check.errors.keys}
                >
                  {(props) => (
                    <Input
                      {...props}
                      {...keyInput}
                      className="font-mono"
                      value={meta}
                      maxLength={32}
                      onChange={(e) => setMeta(e.target.value)}
                    />
                  )}
                </FormField>
                {mode === 'enter' ? (
                  <>
                    <FormField
                      label="File key"
                      required
                      help="32 hex digits."
                      error={check.errors.keys}
                    >
                      {(props) => (
                        <Input
                          {...props}
                          {...keyInput}
                          className="font-mono"
                          value={file}
                          maxLength={32}
                          onChange={(e) => setFile(e.target.value)}
                        />
                      )}
                    </FormField>
                    {nameField ? (
                      <CheckboxField
                        label="Derive a key per tag from this file key"
                        checked={diversify}
                        onCheckedChange={(v) => setDiversify(v === true)}
                      />
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type Body = z.infer<typeof CreateTagKeysetSchema>;

export function NewKeysetDialog({
  create,
  onClose,
}: {
  create: (body: Body) => Promise<MadeKeyset>;
  onClose: () => void;
}) {
  return (
    <KeysDialog
      title={KEYSET_COPY.add}
      confirm="Create"
      modes={['generate', 'enter', 'own']}
      nameField
      build={({ name, mode, meta, file, diversify }) =>
        mode === 'generate'
          ? { name, generate: true, diversify: true }
          : mode === 'own'
            ? { name, perTag: true, metaKey: meta }
            : { name, diversify, metaKey: meta, fileKey: file }
      }
      send={create as never}
      onClose={onClose}
    />
  );
}

export function RotateDialog({
  keyset,
  rotate,
  onClose,
}: {
  keyset: Keyset;
  rotate: (id: string, body: z.infer<typeof RotateTagKeysetSchema>) => Promise<MadeKeyset>;
  onClose: () => void;
}): ReactNode {
  return (
    <KeysDialog
      title={`Rotate keys of ${keyset.name}`}
      confirm="Rotate keys"
      modes={keyset.perTag ? ['own'] : ['generate', 'enter']}
      nameField={false}
      build={({ mode, meta, file }) =>
        mode === 'generate'
          ? { generate: true }
          : mode === 'own'
            ? { metaKey: meta }
            : { metaKey: meta, fileKey: file }
      }
      send={((body: never) => rotate(keyset.id, body)) as never}
      onClose={onClose}
    />
  );
}
