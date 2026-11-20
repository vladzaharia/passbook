import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { NOTE_MAX, NoteSchema } from '../../../../shared/contracts/scan-history.ts';
import { scanLine } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Button } from '../../../ui/button.tsx';
import { ScanTextField } from '../../input/wedge-field.tsx';
import type { AddResult } from './use-notes.ts';

const N = OPERATOR_COPY.notes;
/** The counter shows only when the line is nearly full. */
const COUNT_FROM = NOTE_MAX - 40;
const FAIL: Record<Exclude<AddResult, 'ok'>, string> = {
  full: N.full,
  device: N.deviceFull,
  wait: N.wait,
  failed: N.saveFailed,
};

/**
 * One plain line, saved or dropped. The draft lives here and nowhere else: closing the form, or
 * another person opening, ends it, so a half-typed note never reaches the next person.
 */
export function NoteForm({
  initial = '',
  onSave,
  onClose,
}: {
  initial?: string;
  onSave: (body: string) => Promise<AddResult>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => field.current?.focus(), []);
  const parsed = NoteSchema.safeParse(text);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.success || busy) return;
    setBusy(true);
    const result = await onSave(parsed.data);
    setBusy(false);
    if (result === 'ok') onClose();
    else setProblem(FAIL[result]);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };
  return (
    <form className="op-note-form" onSubmit={submit} onKeyDown={keys} data-testid="op-note-form">
      <ScanTextField
        ref={field}
        value={text}
        maxLength={NOTE_MAX}
        placeholder={N.placeholder}
        aria-label={N.label}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(e) => setText(e.target.value)}
        onValueRestore={setText}
      />
      <div className="op-note-foot">
        <span
          className="op-note-hint"
          role={problem ? 'alert' : undefined}
          data-problem={problem ? true : undefined}
        >
          {problem ??
            (text.length >= COUNT_FROM ? scanLine(N.left, { n: NOTE_MAX - text.length }) : '')}
        </span>
        <Button type="button" variant="ghost" onClick={onClose}>
          {N.cancel}
        </Button>
        <Button type="submit" aria-disabled={!parsed.success || busy || undefined}>
          {busy ? N.saving : N.save}
        </Button>
      </div>
    </form>
  );
}
