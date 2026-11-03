import { Mail, Star, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { EMAIL_INVALID_MESSAGE, strictEmail } from '../../shared/email.ts';
import { ACTION_ICON } from '../lib/action-icons.ts';
import { useInsertHighlight } from '../lib/motion.ts';
import { InlineAddField } from './inline-add-field.tsx';
import { ListRow, ListRows, type RowAction, RowActions } from './list-row.tsx';
import { StatusPill } from './status-pill.tsx';

export interface EmailItem {
  email: string;
  primary: boolean;
  verified: boolean;
  /** A verification is on its way: the row reads "Check your inbox". */
  pending: boolean;
}

export interface EmailListProps {
  items: readonly EmailItem[];
  addLabel?: string;
  /** Return (or resolve) false when the add is refused: the address stays in the field. */
  onAdd: (email: string) => unknown;
  onRemove: (email: string) => void;
  onMakePrimary: (email: string) => void;
  onResend: (email: string) => void;
  onCancelPending: (email: string) => void;
  /** The address an action is running for. */
  busyEmail?: string;
  /** Add-field error from the server (one sentence). */
  addError?: string;
  className?: string;
}

/** The add row checks the address the way the server does (shared/email.ts) before onAdd. */
const checkEmail = (v: string) =>
  !v ? 'Enter an email.' : strictEmail(v) ? undefined : EMAIL_INVALID_MESSAGE;

/**
 * Account emails (portal and admin): address with Primary and Not verified pills, actions trailing,
 * and the add field as the last row with the same rhythm and divider. Presentational.
 */
export function EmailList({
  items,
  addLabel = 'Add email',
  onAdd,
  onRemove,
  onMakePrimary,
  onResend,
  onCancelPending,
  busyEmail,
  addError,
  className,
}: EmailListProps) {
  const [draft, setDraft] = useState('');
  // An error belongs to the address that caused it: editing the address clears it.
  const [editedSinceError, setEdited] = useState(false);
  const [lastError, setLastError] = useState(addError);
  if (lastError !== addError) {
    setLastError(addError);
    setEdited(false);
  }
  const fresh = useInsertHighlight(items.map((i) => i.email));
  // Clear the field once the add is through, unless the user has typed on since.
  const add = async (email: string) => {
    if ((await onAdd(email)) === false) return;
    setDraft((now) => (now.trim() === email ? '' : now));
  };
  const actionsFor = (item: EmailItem): RowAction[] => {
    const busy = busyEmail === item.email;
    if (item.primary && item.verified) return [];
    // An unproven primary can be verified or re-sent, never removed.
    if (item.primary) {
      return [
        {
          label: item.pending ? 'Resend' : 'Verify',
          icon: ACTION_ICON.sendEmail,
          onSelect: () => onResend(item.email),
          disabled: busy,
        },
      ];
    }
    if (item.pending) {
      return [
        {
          label: 'Resend',
          icon: ACTION_ICON.sendEmail,
          onSelect: () => onResend(item.email),
          disabled: busy,
        },
        {
          label: 'Cancel',
          icon: X,
          onSelect: () => onCancelPending(item.email),
          disabled: busy,
          destructive: true,
        },
      ];
    }
    return [
      item.verified
        ? {
            label: 'Make primary',
            icon: Star,
            onSelect: () => onMakePrimary(item.email),
            disabled: busy,
          }
        : {
            label: 'Resend',
            icon: ACTION_ICON.sendEmail,
            onSelect: () => onResend(item.email),
            disabled: busy,
          },
      {
        label: 'Remove',
        icon: Trash2,
        onSelect: () => onRemove(item.email),
        disabled: busy,
        destructive: true,
      },
    ];
  };
  return (
    <ListRows label="Emails" className={className}>
      {items.length === 0 ? (
        <li className="py-3 text-sm text-fg-muted first:pt-0">No emails</li>
      ) : (
        items.map((item) => (
          <ListRow
            key={item.email}
            rowId={item.email}
            isNew={fresh.has(item.email)}
            leading={<Mail aria-hidden />}
            title={item.email}
            pills={
              <>
                {item.primary ? <StatusPill status="primary" /> : null}
                {item.verified ? null : (
                  <StatusPill status={item.pending ? 'check_inbox' : 'unverified'} />
                )}
              </>
            }
            trailing={<RowActions label={`Actions for ${item.email}`} actions={actionsFor(item)} />}
          />
        ))
      )}
      <li className="py-3 last:pb-0">
        <InlineAddField
          label={addLabel}
          type="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={draft}
          validate={checkEmail}
          onChange={(v) => {
            setDraft(v);
            setEdited(true);
          }}
          error={editedSinceError ? undefined : addError}
          busy={busyEmail === draft.trim() && Boolean(draft.trim())}
          onSubmit={(email) => void add(email)}
        />
      </li>
    </ListRows>
  );
}
