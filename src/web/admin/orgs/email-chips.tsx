import { X } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, useRef, useState } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { type FieldControlProps, FormField } from '@/web/ui/index.ts';
import { addEmails, type EmailChip } from './invite-emails.ts';

export interface EmailChipsProps {
  chips: readonly EmailChip[];
  onChange: (chips: EmailChip[]) => void;
  /** The text not yet turned into a chip, so submit can take it. */
  draft: string;
  onDraft: (text: string) => void;
  error?: string | undefined;
  /** Per-address refusals from the server, by email. */
  refused?: Readonly<Record<string, string>>;
}

/** Several addresses in one field: comma, space, Enter, paste or leaving the field makes a chip. */
export function EmailChips({ chips, onChange, draft, onDraft, error, refused }: EmailChipsProps) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const commit = (text: string) => {
    if (text.trim()) onChange(addEmails(chips, text));
    onDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      if (draft.trim()) {
        event.preventDefault();
        commit(draft);
      }
    } else if (event.key === 'Backspace' && draft === '' && chips.length > 0) {
      onChange(chips.slice(0, -1));
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (/[\s,;]/.test(text.trim())) {
      event.preventDefault();
      commit(`${draft}${text}`);
    }
  };
  const control = (props: FieldControlProps) => (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click on the box focuses the input inside it
    <div
      onClick={() => input.current?.focus()}
      className={cn(
        'flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-surface-raised px-2 py-1 wl-colors hover:border-fg-muted pointer-coarse:min-h-11',
        focused && 'outline-2 outline-offset-2 outline-focus',
        error && 'border-danger',
      )}
    >
      <ul aria-label="Addresses" className="contents">
        {chips.map((chip) => (
          <li
            key={chip.email}
            data-invalid={!chip.valid || refused?.[chip.email] ? '' : undefined}
            className={cn(
              'inline-flex min-h-6 max-w-full items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs font-medium',
              chip.valid && !refused?.[chip.email]
                ? 'border-border bg-state-hover-tint text-fg'
                : 'border-danger-border bg-danger-subtle text-danger',
            )}
          >
            <span className="truncate">{chip.email}</span>
            <button
              type="button"
              aria-label={`Remove ${chip.email}`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(chips.filter((c) => c.email !== chip.email));
                input.current?.focus();
              }}
              className="inline-flex size-4 items-center justify-center rounded-full wl-colors hover:bg-state-hover-tint pointer-coarse:size-6"
            >
              <X aria-hidden className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <input
        {...props}
        ref={input}
        type="text"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        data-autofocus
        data-draft
        value={draft}
        placeholder={chips.length ? '' : 'name@example.com'}
        onChange={(event) => {
          const text = event.target.value;
          if (/[,;\n]$/.test(text)) commit(text);
          else onDraft(text);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit(draft);
        }}
        className="min-w-32 flex-1 bg-transparent py-1 text-sm text-fg outline-none placeholder:text-fg-subtle"
      />
    </div>
  );
  const refusals = chips.flatMap((chip) => (refused?.[chip.email] ? [chip.email] : []));
  return (
    <FormField label="Emails" error={error} help="Separate with commas or new lines.">
      {(props) => (
        <>
          {control(props)}
          {refusals.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-danger">
              {refusals.map((email) => (
                <li key={email}>
                  {email}: {refused?.[email]}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </FormField>
  );
}
