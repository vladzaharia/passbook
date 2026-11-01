import { Smartphone } from 'lucide-react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { formatDateTime, formatDay } from '../../../lib/format.ts';
import { useInsertHighlight } from '../../../lib/motion.ts';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ListRow,
  ListRows,
  StatusPill,
} from '../../../ui/index.ts';

/** Devices with the pass in Wallet: when each added it and how its last push went. */
export function DevicesCard({ pass }: { pass: PassDetailDto }) {
  const fresh = useInsertHighlight(pass.devices.map((d) => d.shortId));
  return (
    <Card className="min-w-0">
      <CardHeader title="Devices" />
      {pass.devices.length === 0 ? (
        <EmptyState inline art="phone" title="No devices yet" />
      ) : (
        <CardBody>
          <ListRows label="Devices">
            {pass.devices.map((d) => (
              <ListRow
                key={d.shortId}
                rowId={d.shortId}
                isNew={fresh.has(d.shortId)}
                leading={<Smartphone aria-hidden />}
                title={
                  <>
                    Device <span className="font-mono text-xs text-fg-muted">{d.shortId}</span>
                  </>
                }
                meta={`Added ${formatDay(d.createdAt)}${
                  d.lastPush ? ` · Last push ${formatDateTime(d.lastPush.at)}` : ''
                }`}
                trailing={
                  d.lastPush ? (
                    <StatusPill status={d.lastPush.state} />
                  ) : (
                    <span className="text-xs text-fg-muted">No push yet</span>
                  )
                }
              />
            ))}
          </ListRows>
        </CardBody>
      )}
    </Card>
  );
}
