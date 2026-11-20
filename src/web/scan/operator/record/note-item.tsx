import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { PassNote } from '../../../../shared/contracts/scan-history.ts';
import { scanLine } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { formatShortDate } from '../../../lib/format.ts';
import { Button } from '../../../ui/button.tsx';
import { NoteForm } from './note-form.tsx';
import type { AddResult } from './use-notes.ts';

const N = OPERATOR_COPY.notes;

/** One note. Its author, or a Manager, may change or delete it; the server holds the same line. */
export function NoteItem({
  note,
  mayChange,
  onEdit,
  onDelete,
}: {
  note: PassNote;
  mayChange: boolean;
  onEdit: (body: string) => Promise<AddResult>;
  onDelete: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const [failed, setFailed] = useState(false);
  if (mode === 'edit')
    return (
      <li className="op-staff-note" data-testid="op-staff-note">
        <NoteForm initial={note.body} onSave={onEdit} onClose={() => setMode('view')} />
      </li>
    );
  return (
    <li className="op-staff-note" data-testid="op-staff-note">
      <p>{note.body}</p>
      <span className="op-staff-note-by">
        {scanLine(N.by, { name: note.by, when: formatShortDate(note.at) })}
        {note.edited ? ` · ${N.edited}` : ''}
      </span>
      {mayChange && mode === 'view' ? (
        <span className="op-staff-note-acts">
          <Button
            variant="ghost"
            size="sm"
            iconStart={<Pencil aria-hidden />}
            aria-label={N.edit}
            onClick={() => setMode('edit')}
          />
          <Button
            variant="ghost"
            size="sm"
            iconStart={<Trash2 aria-hidden />}
            aria-label={N.remove}
            onClick={() => setMode('delete')}
          />
        </span>
      ) : null}
      {mode === 'delete' ? (
        <span className="op-staff-note-ask" role="alert">
          {N.sure}
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              setFailed(!(await onDelete()));
            }}
          >
            {N.remove}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode('view')}>
            {N.keep}
          </Button>
          {failed ? <b>{N.removeFailed}</b> : null}
        </span>
      ) : null}
    </li>
  );
}
