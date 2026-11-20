import { Pencil, Undo2 } from 'lucide-react';
import type { EntitlementItemDto } from '@/shared/contracts/entitlement-admin.ts';
import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import { cn } from '@/web/lib/cn.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  IconButton,
  ListRow,
  ListRows,
} from '@/web/ui/index.ts';
import { FEATURE_GROUPS, formatValue, isOff } from './values.ts';

/** The features by section: the value the org has, where it comes from, and the override controls. */
export function FeatureList({
  items,
  presetLabel,
  busy,
  onEdit,
  onReset,
}: {
  items: readonly EntitlementItemDto[];
  presetLabel: string;
  busy: boolean;
  onEdit: (key: EntitlementKey) => void;
  onReset: (key: EntitlementKey) => void;
}) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  return (
    <>
      {FEATURE_GROUPS.map((group) => {
        const rows = group.keys.flatMap((key) => {
          const item = byKey.get(key);
          return item ? [item] : [];
        });
        if (rows.length === 0) return null;
        return (
          <Card key={group.title}>
            <CardHeader title={group.title} />
            <CardBody>
              <ListRows label={group.title}>
                {rows.map((item) => {
                  const label = ENTITLEMENT_LABEL[item.key];
                  const override = item.source === 'override';
                  return (
                    <ListRow
                      key={item.key}
                      rowId={item.key}
                      title={label}
                      pills={override ? <Badge tone="info">Override</Badge> : null}
                      meta={
                        override ? (
                          <>
                            {presetLabel}: {formatValue(item.key, item.presetValue)}
                            {item.note ? ` · ${item.note}` : ''}
                            {item.expiresAt ? ` · Until ${formatDateTime(item.expiresAt)}` : ''}
                          </>
                        ) : undefined
                      }
                      trailing={
                        <>
                          <span
                            className={cn(
                              'mr-2 text-sm tabular-nums',
                              isOff(item.key, item.value) ? 'text-fg-muted' : 'text-fg-strong',
                            )}
                          >
                            {formatValue(item.key, item.value)}
                          </span>
                          <IconButton
                            label={`Override ${label}`}
                            size="sm"
                            disabled={busy}
                            icon={<Pencil aria-hidden />}
                            onClick={() => onEdit(item.key)}
                          />
                          {override ? (
                            <IconButton
                              label={`Reset ${label} to ${presetLabel}`}
                              size="sm"
                              disabled={busy}
                              icon={<Undo2 aria-hidden />}
                              onClick={() => onReset(item.key)}
                            />
                          ) : null}
                        </>
                      }
                    />
                  );
                })}
              </ListRows>
            </CardBody>
          </Card>
        );
      })}
    </>
  );
}
