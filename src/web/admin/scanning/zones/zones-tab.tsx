import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { ScanZone } from '@/shared/contracts/scan-access.ts';
import { archiveZoneConfirm } from '@/web/lib/confirms.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, ConfirmDialog, EmptyState, ErrorState, Skeleton, toast } from '@/web/ui/index.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { useInsideApi } from './inside-api.ts';
import { InsideSheet } from './inside-sheet.tsx';
import { ZoneDialog } from './zone-dialog.tsx';
import { type ZoneNode, zoneNodes } from './zone-tree.ts';
import { ZoneTreeList } from './zone-tree-list.tsx';
import { useArchiveZone, useZones, zonesUnavailable } from './zones-api.ts';

type Dialog =
  | { type: 'create'; parentId?: string }
  | { type: 'edit'; zone: ScanZone }
  | { type: 'archive'; node: ZoneNode }
  | { type: 'inside'; zone: ScanZone };

export function ZonesTab() {
  const { orgId, membership } = useOrgScope();
  if (!orgId) return <OrgChooser inline />;
  const canManage = membership?.capabilities.includes('scanning:manage') ?? false;
  return <OrgZones key={`${orgId}:${canManage}`} orgId={orgId} canManage={canManage} />;
}

function OrgZones({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const active = useZones(orgId, false);
  const archived = useZones(orgId, true, !zonesUnavailable(active.error));
  const archive = useArchiveZone();
  const insideApi = useInsideApi();
  const [dialog, setDialog] = useState<Dialog>();
  const [showArchived, setShowArchived] = useState(false);
  const close = () => setDialog(undefined);

  if (active.isError) {
    return zonesUnavailable(active.error) ? (
      <EmptyState art="building" title="Zones are unavailable" />
    ) : (
      <ErrorState error={active.error} subject="zones" onRetry={() => active.refetch()} />
    );
  }
  if (active.isPending) return <Skeleton className="h-48 w-full" />;
  const zones = active.data;
  const nodes = zoneNodes(zones);
  const gone = archived.data ?? [];
  const create = () => setDialog({ type: 'create' });
  const actions = {
    edit: (zone: ScanZone) => setDialog({ type: 'edit', zone }),
    addInside: (zone: ScanZone) => setDialog({ type: 'create', parentId: zone.id }),
    archive: (node: ZoneNode) => setDialog({ type: 'archive', node }),
    restore: (zone: ScanZone) =>
      archive.mutate(
        { id: zone.id, archive: false },
        {
          onSuccess: () => toast.success(`${zone.name} restored`),
          onError: (cause) => toast.error(cause, 'Could not restore'),
        },
      ),
    ...(insideApi ? { inside: (zone: ScanZone) => setDialog({ type: 'inside', zone }) } : {}),
  };
  const confirming = dialog?.type === 'archive' ? dialog.node : undefined;
  return (
    <div className="grid gap-4">
      {nodes.length === 0 ? (
        <EmptyState
          art="building"
          title="No zones yet"
          action={canManage ? <Button onClick={create}>New zone</Button> : undefined}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {canManage ? (
              <Button iconStart={<Plus aria-hidden />} onClick={create}>
                New zone
              </Button>
            ) : null}
          </div>
          <ZoneTreeList nodes={nodes} label="Zones" actions={actions} canManage={canManage} />
        </>
      )}
      {gone.length ? (
        <div className="grid gap-3">
          <Button
            variant="ghost"
            className="justify-self-start"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? 'Hide archived' : `Show archived (${gone.length})`}
          </Button>
          {showArchived ? (
            <ZoneTreeList
              nodes={zoneNodes(gone)}
              label="Archived zones"
              actions={actions}
              canManage={canManage}
            />
          ) : null}
        </div>
      ) : null}
      {dialog?.type === 'create' || dialog?.type === 'edit' ? (
        <ZoneDialog
          orgId={orgId}
          zones={zones}
          zone={dialog.type === 'edit' ? dialog.zone : undefined}
          parentId={dialog.type === 'create' ? dialog.parentId : undefined}
          onClose={close}
        />
      ) : null}
      {confirming ? (
        <ConfirmDialog
          open
          destructive
          onOpenChange={(open) => !open && close()}
          {...archiveZoneConfirm(confirming.zone.name, {
            sessions: confirming.zone.sessions,
            plans: confirming.zone.plans.length,
            below: confirming.below,
          })}
          onConfirm={async () => {
            await archive.mutateAsync({ id: confirming.zone.id, archive: true });
            toast.success(`${confirming.zone.name} archived`);
          }}
        />
      ) : null}
      {insideApi && dialog?.type === 'inside' ? (
        <InsideSheet
          api={insideApi}
          zoneId={dialog.zone.id}
          zoneName={dialog.zone.name}
          canManage={canManage}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
