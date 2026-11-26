import { Code2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { removeDeveloperConfirm } from '@/web/lib/confirms-members.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Badge,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ListRow,
  ListRows,
  RowActions,
  toast,
} from '@/web/ui/index.ts';
import { useDevelopers } from './queries.ts';

type Target =
  | { kind: 'developer'; id: string; name: string }
  | { kind: 'invitation'; id: string; name: string };

/** Developers under Members: who has developer access, and who is invited. Renders only when the API says it is available. */
export function DevelopersSection({ orgId }: { orgId: string }) {
  const { developers, invitations, available, remove, revoke } = useDevelopers(orgId);
  const [asking, setAsking] = useState<Target | null>(null);
  if (!available) return null;
  const people = developers.data?.items ?? [];
  const pending = (invitations.data?.items ?? []).filter((i) => i.state === 'pending');
  const empty = people.length === 0 && pending.length === 0;

  const rows = (
    <ListRows label="Developers">
      {people.map((d) => {
        const name = d.name ?? d.email ?? 'Developer';
        return (
          <ListRow
            key={d.userId}
            leading={<Code2 aria-hidden />}
            title={name}
            pills={<Badge tone="success">Active</Badge>}
            meta={`Since ${formatDateTime(d.since, '')}`}
            trailing={
              <RowActions
                label={`Actions for ${name}`}
                actions={[
                  {
                    label: 'Remove',
                    icon: Trash2,
                    destructive: true,
                    onSelect: () => setAsking({ kind: 'developer', id: d.userId, name }),
                  },
                ]}
              />
            }
          />
        );
      })}
      {pending.map((i) => (
        <ListRow
          key={i.id}
          leading={<Code2 aria-hidden />}
          title={i.email}
          pills={<Badge>Invited</Badge>}
          meta={`Expires ${formatDateTime(i.expiresAt, '')}`}
          trailing={
            <RowActions
              label={`Actions for ${i.email}`}
              actions={[
                {
                  label: 'Revoke',
                  icon: Trash2,
                  destructive: true,
                  onSelect: () => setAsking({ kind: 'invitation', id: i.id, name: i.email }),
                },
              ]}
            />
          }
        />
      ))}
    </ListRows>
  );

  return (
    <Card>
      <CardHeader title="Developers" />
      <div className="p-4">
        {empty ? <EmptyState inline art="people" title="No developers." /> : rows}
      </div>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        {...(asking
          ? removeDeveloperConfirm(asking.name)
          : { title: '', confirmLabel: '', description: '' })}
        confirmLabel={asking?.kind === 'invitation' ? 'Revoke' : 'Remove'}
        destructive
        onConfirm={async () => {
          if (!asking) return;
          if (asking.kind === 'developer') await remove.mutateAsync(asking.id);
          else await revoke.mutateAsync(asking.id);
          toast.success(asking.kind === 'developer' ? 'Developer removed' : 'Invitation revoked');
        }}
      />
    </Card>
  );
}
