import { Plus, StickyNote } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Button } from '../../../ui/button.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { Kbd } from '../workspace/command-field.tsx';
import { NoteForm } from './note-form.tsx';
import { NoteItem } from './note-item.tsx';
import { type AddResult, useNotes } from './use-notes.ts';
import './notes.css';

const N = OPERATOR_COPY.notes;

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
  const opener = useRef<HTMLButtonElement | null>(null);
  const was = useRef(false);
  useEffect(() => {
    // Closing gives focus back to the button that opened.
    if (was.current && !open) opener.current?.focus();
    was.current = open;
  }, [open]);
  if (open) return <NoteForm onSave={onSave} onClose={onClose} />;
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
}

/**
 * Staff notes on this person, newest first: one plain line each, with the author and the day.
 * Desk and above only; a Door never reaches this. `openSignal` is the N key and the Note button.
 */
export function Notes({
  api,
  passId,
  openSignal,
  manager,
  onAdded,
}: {
  api: ScanApi;
  passId: string;
  openSignal: number;
  /** A Manager and above may change any note; anyone else, their own. */
  manager: boolean;
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
            <NoteItem
              key={note.id}
              note={note}
              mayChange={manager || note.own}
              onEdit={(body) => notes.edit(note.id, body)}
              onDelete={() => notes.remove(note.id)}
            />
          ))}
        </ul>
      )}
      <AddNote
        key={passId}
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        onSave={notes.add}
      />
    </section>
  );
}
