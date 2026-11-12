import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ScanEventDto, ScannerListSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { CheckboxField } from '@/web/ui/checkbox.tsx';
import { Button, Callout, Dialog, DialogContent } from '@/web/ui/index.ts';

export function AssignDialog({ event, onClose }: { event: ScanEventDto; onClose: () => void }) {
  const client = useQueryClient();
  const scanners = useQuery({
    queryKey: ['admin', 'scanning', 'assign', event.orgId],
    queryFn: ({ signal }) =>
      api.get('/api/v1/scanners', ScannerListSchema, {
        query: { orgId: event.orgId, limit: 200 },
        signal,
      }),
  });
  const [selected, setSelected] = useState<string[] | null>(null);
  const items = (scanners.data?.items ?? []).filter(
    (scanner) => scanner.orgId === event.orgId && scanner.status !== 'revoked',
  );
  const ids = (
    selected ??
    items
      .filter(
        (scanner) =>
          scanner.accepts && 'eventId' in scanner.accepts && scanner.accepts.eventId === event.id,
      )
      .map((scanner) => scanner.id)
  ).filter((id) => items.some((scanner) => scanner.id === id));
  const mutation = useMutation({
    mutationFn: () =>
      api.action('POST', `/api/v1/scan-events/${encodeURIComponent(event.id)}/scanners`, {
        scannerIds: ids,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'scanning'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title="Assign scanners" size="sm">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">Selected scanners move to {event.name}.</p>
          {items.map((s) => (
            <CheckboxField
              key={s.id}
              label={s.name}
              checked={ids.includes(s.id)}
              onCheckedChange={(checked) =>
                setSelected(checked ? [...ids, s.id] : ids.filter((id) => id !== s.id))
              }
            />
          ))}
          {!items.length && !scanners.isPending ? (
            <p>No scanners yet. Add a scanner in Scanning.</p>
          ) : null}
          {mutation.isError || scanners.isError ? (
            <Callout tone="danger">{errorMessage(mutation.error ?? scanners.error)}</Callout>
          ) : null}
          <Button
            disabled={scanners.isPending || scanners.isError}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Assign scanners
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
