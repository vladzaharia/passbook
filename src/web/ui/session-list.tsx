import { ACTION_ICON } from '../lib/action-icons.ts';
import { deviceIcon, deviceLabel } from '../lib/device.ts';
import { formatDateTime } from '../lib/format.ts';
import { useInsertHighlight } from '../lib/motion.ts';
import { Button } from './button.tsx';
import { ListRow, ListRows } from './list-row.tsx';
import { StatusPill } from './status-pill.tsx';

export interface SessionItem {
  id: string;
  userAgent: string | null;
  current: boolean;
  /** How it signed in: "Polaris ID", "Email link". */
  method?: string | null;
  lastSeenAt: number;
  createdAt: number;
}

export interface SessionListProps {
  items: readonly SessionItem[];
  /** Revoke a session; the row leaves with a transition once the caller removes it. */
  onRevoke: (id: string) => void;
  /** The id being revoked. */
  revoking?: string;
  className?: string;
}

/**
 * Signed-in devices (portal and admin): device icon, "Chrome on macOS", last active and signed in.
 * The This device pill sits exactly where Revoke sits on the other rows. Callers drop a revoked
 * row inside removeWithTransition (lib/motion.ts) so it leaves with a transition.
 */
export function SessionList({ items, onRevoke, revoking, className }: SessionListProps) {
  const fresh = useInsertHighlight(items.map((s) => s.id));
  return (
    <ListRows label="Sessions" className={className}>
      {items.map((s) => {
        const Icon = deviceIcon(s.userAgent);
        const label = deviceLabel(s.userAgent);
        const meta = [
          `Last active ${formatDateTime(s.lastSeenAt)}`,
          `Signed in ${formatDateTime(s.createdAt)}`,
          s.method,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <ListRow
            key={s.id}
            rowId={s.id}
            isNew={fresh.has(s.id)}
            leading={<Icon aria-hidden />}
            title={label}
            meta={meta}
            trailing={
              s.current ? (
                <StatusPill status="this_device" icon={Icon} />
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={revoking === s.id}
                  iconStart={<ACTION_ICON.signOut aria-hidden />}
                  aria-label={`Revoke ${label}`}
                  onClick={() => onRevoke(s.id)}
                >
                  Revoke
                </Button>
              )
            }
          />
        );
      })}
    </ListRows>
  );
}
