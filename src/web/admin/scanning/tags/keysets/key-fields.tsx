import { KeyRound, ShieldCheck, Upload } from 'lucide-react';
import { useId, useState } from 'react';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { CheckboxField, FormField, Input, OptionTile } from '@/web/ui/index.ts';

type Mode = 'generate' | 'enter' | 'own';
const C = KEYSET_COPY.mode;
const MODES = [
  { value: 'generate', label: C.generate, description: C.generateHelp, icon: ShieldCheck },
  { value: 'enter', label: C.enter, description: C.enterHelp, icon: KeyRound },
  { value: 'own', label: C.own, description: C.ownHelp, icon: Upload },
] as const;

const keyInput = { autoComplete: 'off', autoCapitalize: 'off', spellCheck: false } as const;

/** How the keys come: generated and shown once, entered, or (imported tags) the meta key only. */
export function useKeyDraft(first: Mode) {
  const [mode, setMode] = useState<Mode>(first);
  const [meta, setMeta] = useState('');
  const [file, setFile] = useState('');
  const [diversify, setDiversify] = useState(true);
  return {
    mode,
    meta,
    file,
    diversify,
    setMode,
    setMeta,
    setFile,
    setDiversify,
    dirty: meta !== '' || file !== '' || mode !== first,
    trimmed: { meta: meta.trim(), file: file.trim() },
  };
}
type KeyDraft = ReturnType<typeof useKeyDraft>;

/** The way the keys come, as tiles. */
export function ModeTiles({
  modes,
  draft,
  legend = 'Keys',
}: {
  modes: readonly Mode[];
  draft: KeyDraft;
  legend?: string;
}) {
  const group = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium text-fg-strong">{legend}</legend>
      {MODES.filter((m) => modes.includes(m.value)).map((m) => (
        <OptionTile
          key={m.value}
          name={group}
          value={m.value}
          label={m.label}
          description={m.description}
          icon={m.icon}
          checked={draft.mode === m.value}
          onSelect={() => draft.setMode(m.value)}
        />
      ))}
    </fieldset>
  );
}

/** The key fields the chosen mode needs; Generate needs none. */
export function KeyInputs({
  draft,
  error,
  diversifyChoice,
  autoFocus,
}: {
  draft: KeyDraft;
  error: string | undefined;
  /** A new keyset may derive a key per tag from the file key. */
  diversifyChoice: boolean;
  autoFocus?: boolean;
}) {
  if (draft.mode === 'generate') return null;
  return (
    <>
      <FormField label="Meta key" required help="32 hex digits." error={error}>
        {(props) => (
          <Input
            {...props}
            {...keyInput}
            {...(autoFocus ? { 'data-autofocus': true } : {})}
            className="font-mono"
            value={draft.meta}
            maxLength={32}
            onChange={(e) => draft.setMeta(e.target.value)}
          />
        )}
      </FormField>
      {draft.mode === 'enter' ? (
        <>
          <FormField label="File key" required help="32 hex digits." error={error}>
            {(props) => (
              <Input
                {...props}
                {...keyInput}
                className="font-mono"
                value={draft.file}
                maxLength={32}
                onChange={(e) => draft.setFile(e.target.value)}
              />
            )}
          </FormField>
          {diversifyChoice ? (
            <CheckboxField
              label="Derive a key per tag from this file key"
              checked={draft.diversify}
              onCheckedChange={(v) => draft.setDiversify(v === true)}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
