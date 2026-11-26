import { UserX } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, CardHeader } from '@/web/ui/index.ts';
import { OffboardDialog } from './offboard-dialog.tsx';
import { useAccessActions } from './queries.ts';

/** Danger zone: the dry-run plan loads when the confirm opens; confirming starts the operation. */
export function OffboardCard({
  userId,
  name,
  onStarted,
}: {
  userId: string;
  name: string;
  onStarted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { plan, offboard } = useAccessActions(userId, onStarted);

  const ask = () => {
    setOpen(true);
    plan.reset();
    plan.mutate();
  };

  return (
    <Card>
      <CardHeader
        title="Offboard"
        actions={
          <Button variant="outline" size="sm" iconStart={<UserX aria-hidden />} onClick={ask}>
            Offboard
          </Button>
        }
      />
      <OffboardDialog
        open={open}
        onOpenChange={setOpen}
        name={name}
        plan={plan.data}
        loading={plan.isPending}
        loadError={plan.error}
        onConfirm={async () => {
          await offboard.mutateAsync();
        }}
      />
    </Card>
  );
}
