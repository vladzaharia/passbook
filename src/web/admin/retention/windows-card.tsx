import { RETENTION_COPY, RETENTION_LINES } from '@/shared/copy/retention.ts';
import { DATA_CLASSES, RETENTION_CLASSES } from '@/shared/privacy/data-classes.ts';
import { pluralize } from '@/web/lib/format.ts';
import { Card, CardBody, CardHeader, ErrorState, KeyValue, SkeletonRows } from '@/web/ui/index.ts';
import { ORG_FIELDS } from '../settings/fields-org.ts';
import { useSettings } from '../settings/queries.ts';
import { SettingsForm } from '../settings/settings-form.tsx';

const FIELDS = ORG_FIELDS.filter((f) => f.group === 'Retention').map(
  ({ group: _group, ...field }) => field,
);

/** Read-only for a member without org:manage: the effective days and what each window deletes. */
function EffectiveWindows({ orgId }: { orgId: string }) {
  const query = useSettings(`org:${orgId}`);
  if (query.isPending) return <SkeletonRows rows={4} label="Loading retention" />;
  if (query.isError)
    return <ErrorState subject="retention" error={query.error} onRetry={() => query.refetch()} />;
  const items = RETENTION_CLASSES.map((cls) => {
    const days = query.data.items.find((i) => i.key === DATA_CLASSES[cls].key)?.value;
    return {
      label: DATA_CLASSES[cls].label,
      value: (
        <>
          {typeof days === 'number' ? pluralize(days, 'day') : 'Platform default'}
          <span className="block text-xs text-fg-muted">{RETENTION_LINES[cls]}</span>
        </>
      ),
    };
  });
  return <KeyValue items={items} />;
}

export function WindowsCard({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  return (
    <Card>
      <CardHeader title={RETENTION_COPY.windowsTitle} />
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          {canManage ? RETENTION_COPY.windowsNote : RETENTION_COPY.readOnlyWindows}
        </p>
        {canManage ? (
          <SettingsForm scope={`org:${orgId}`} fields={FIELDS} columns />
        ) : (
          <EffectiveWindows orgId={orgId} />
        )}
      </CardBody>
    </Card>
  );
}
