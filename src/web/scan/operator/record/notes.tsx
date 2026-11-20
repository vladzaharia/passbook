import { Plus, StickyNote } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { NOTE_MAX, NoteSchema } from '../../../../shared/contracts/scan-history.ts';
import { scanLine } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { formatShortDate } from '../../../lib/format.ts';
import { Button } from '../../../ui/button.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { ScanTextField } from '../../input/wedge-field.tsx';
import { Kbd } from '../workspace/command-field.tsx';
import { type AddResult, useNotes } from './use-notes.ts';
import './notes.css';

const N = OPERATOR_COPY.notes;
/** The counter shows only when the line is nearly full. */
const COUNT_FROM = NOTE_MAX - 40;
const FAIL: Record<Exclude<AddResult, 'ok'>, string> = {
  full: N.full,
  wait: N.wait,
  failed: N.saveFailed,
};

function AddNote({
  open,
  onOpen,
  onClose,
  onSave,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSave: (body: string) => Promise<AddResult>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const was = useRef(false);
  useEffect(() => {
    // Operator-initiated: opening takes the field, closing gives focus back to the button.
    if (open) field.current?.focus();
    else if (was.current) opener.current?.focus();
    was.current = open;
  }, [open]);
  const parsed = NoteSchema.safeParse(text);
  const close = () => {
    setText('');
    setProblem(null);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.success || busy) return;
    setBusy(true);
    const result = await onSave(parsed.data);
    setBusy(false);
    if (result === 'ok') close();
    else setProblem(FAIL[result]);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  if (!open)
    return (
      <button
        ref={opener}
        type="button"
        className="op-note-add"
        data-testid="op-note-add"
        aria-keyshortcuts="N"
        onClick={onOpen}
      >
        <Plus aria-hidden /> {N.add}
        <span className="op-keycap" aria-hidden>
          <Kbd>N</Kbd>
        </span>
      </button>
    );
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
        <Button type="button" variant="ghost" onClick={close}>
          {N.cancel}
        </Button>
        <Button type="submit" aria-disabled={!parsed.success || busy || undefined}>
          {busy ? N.saving : N.save}
        </Button>
      </div>
    </form>
  );
}

/**
 * Staff notes on this person, newest first: one plain line each, with the author and the day.
 * Desk and above only; a Door never reaches this. `openSignal` is the N key and the Note button.
 */
export function Notes({
  api,
  passId,
  openSignal,
  onAdded,
}: {
  api: ScanApi;
  passId: string;
  openSignal: number;
  /** A note was saved: the history lists it too. */
  onAdded: () => void;
}) {
  const notes = useNotes(api, passId, true, onAdded);
  const [open, setOpen] = useState(false);
  const seen = useRef(openSignal);
  useEffect(() => {
    if (openSignal !== seen.current) setOpen(true);
    seen.current = openSignal;
  }, [openSignal]);
  // Another person: no half-typed note carries over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pass closes the form
  useEffect(() => setOpen(false), [passId]);
  return (
    <section className="op-block op-notes" aria-label={N.heading} data-testid="op-notes">
      <div className="op-block-h">
        <h3>
          <StickyNote aria-hidden /> {N.heading}
        </h3>
        <span className="op-block-aside">{N.aside}</span>
      </div>
      {notes.failed ? (
        <p className="op-hist-fail" role="status">
          {N.failed}{' '}
          <Button variant="link" onClick={notes.retry}>
            {N.retry}
          </Button>
        </p>
      ) : (
        <ul className="op-staff-notes">
          {notes.items.map((note) => (
            <li key={note.id} className="op-staff-note" data-testid="op-staff-note">
              <p>{note.body}</p>
              <span>{scanLine(N.by, { name: note.by, when: formatShortDate(note.at) })}</span>
            </li>
          ))}
        </ul>
      )}
      <AddNote
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        onSave={notes.add}
      />
    </section>
  );
}
