import { Mail, RotateCw, Star, Trash2, X } from 'lucide-react';
import { useState } from 'react';
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
  onAdd: (email: string) => void;
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

/**
 * Account emails (portal and admin): address with Primary and Unverified pills, actions trailing,
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
  const fresh = useInsertHighlight(items.map((i) => i.email));
  const actionsFor = (item: EmailItem): RowAction[] => {
    const busy = busyEmail === item.email;
    if (item.primary) return [];
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
        : { label: 'Resend', icon: RotateCw, onSelect: () => onResend(item.email), disabled: busy },
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
                  <StatusPill status="waiting">
                    {item.pending ? 'Check your inbox' : 'Unverified'}
                  </StatusPill>
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
          onChange={setDraft}
          error={addError}
          busy={busyEmail === draft.trim() && Boolean(draft.trim())}
          onSubmit={(email) => {
            onAdd(email);
            setDraft('');
          }}
        />
      </li>
    </ListRows>
  );
}
