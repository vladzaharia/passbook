import { Ban, QrCode } from 'lucide-react';
import { useState } from 'react';
import { DEVICE_PASS_MAX_DEVICES, type DevicePassDto } from '@/shared/contracts/device-passes.ts';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { ApiError } from '../../lib/errors.ts';
import { isStepUp } from '../../lib/step-up.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { toast } from '../../ui/toaster.tsx';
import { StatusChip, type StatusTone } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { ToolFailed } from '../states/states.tsx';
import {
  type DeviceMake,
  useDevicePasses,
  useMakeDevicePass,
  useVoidDevicePass,
} from './device-pass-api.ts';
import { DevicePassDialog } from './device-pass-dialog.tsx';
import { titleOf } from './model.ts';
import { PassThumb } from './pass-thumb.tsx';

const D = WB_PASSES.device;
const TONE: Record<DevicePassDto['state'], StatusTone> = {
  pending: 'info',
  active: 'success',
  voided: 'neutral',
  expired: 'neutral',
};
const open = (p: DevicePassDto) => p.state === 'pending' || p.state === 'active';

/**
 * On my phone in a sandbox (design §3.4, S4): the sandbox's passes as Test passes on your own phone. Make one
 * and its one-time code opens in a dialog; the list below keeps each pass's phones (3 at most), its life, Void
 * and Add again. Only the server's flag shows it.
 */
export function DevicePhoneView({ passes }: { passes: readonly PassSummaryDto[] }) {
  const zone = useToolHost().context.timeZone;
  const list = useDevicePasses();
  const make = useMakeDevicePass();
  const voidIt = useVoidDevicePass();
  const [shown, setShown] = useState<{ pass: DevicePassDto; title: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const titles = new Map(passes.map((p) => [p.id, titleOf(p)]));
  const sources = passes.filter((p) => p.status === 'active' && p.removedAt === null);
  const items = list.data?.items ?? [];
  const active = list.data?.active ?? 0;
  const limit = list.data?.limit ?? 5;
  const full = active >= limit;

  function run(v: DeviceMake, title: string) {
    make.mutate(v, {
      onSuccess: (pass) => {
        setBlocked(false);
        setShown({ pass, title });
      },
      onError: (error) => {
        if (error instanceof ApiError && error.code === 'DEVICE_PASS_BLOCKED') setBlocked(true);
        // A step-up opens its own dialog; the click is made again after it.
        else if (!isStepUp(error)) toast.error(error, D.makeFailed);
      },
    });
  }
  function confirmVoid(id: string) {
    voidIt.mutate(id, {
      onSuccess: () => {
        setAsking(null);
        toast.success(D.voided);
      },
      onError: (error) => !isStepUp(error) && toast.error(error, D.voidFailed),
    });
  }

  if (list.isPending) return <Skeleton className="h-40 w-full" />;
  if (list.isError) return <ToolFailed error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {blocked ? (
        <Callout tone="danger">{D.blocked}</Callout>
      ) : full ? (
        <Callout tone="warning">{D.limit}</Callout>
      ) : null}
      <section aria-label={D.makeList} className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-fg-muted">{D.rule}</p>
        {sources.length === 0 ? (
          <p className="text-sm text-fg-muted">{WB_PASSES.phone.empty}</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {sources.map((p) => (
              <li
                key={p.id}
                className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-raised p-3"
              >
                <PassThumb voided={false} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-strong">
                  {titleOf(p)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  iconStart={<QrCode aria-hidden />}
                  disabled={full || blocked}
                  loading={
                    make.isPending &&
                    make.variables?.kind === 'make' &&
                    make.variables.passId === p.id
                  }
                  onClick={() => run({ kind: 'make', passId: p.id }, titleOf(p))}
                >
                  {D.make}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label={D.list} className="flex min-w-0 flex-col gap-2">
        <h2 className="text-sm font-semibold text-fg-strong">{D.list}</h2>
        {items.length === 0 ? (
          <p className="text-sm text-fg-muted">{D.noneYet}</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {items.map((dp) => {
              const title = titles.get(dp.passId) ?? WB_PASSES.untitled;
              const live = open(dp);
              return (
                <li
                  key={dp.id}
                  className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="min-w-0 flex-1 basis-40">
                      <span className="block truncate text-sm font-semibold text-fg-strong">
                        {title}
                      </span>
                      <span className="block text-xs text-fg-muted">
                        {D.phones(dp.deviceCount, DEVICE_PASS_MAX_DEVICES)}
                        {live ? (
                          <>
                            {' · '}
                            {D.expires} <BenchTime at={dp.expiresAt} mode="until" zone={zone} />
                          </>
                        ) : null}
                        {dp.lastSeenAt !== null ? (
                          <>
                            {' · '}
                            {D.seen} <BenchTime at={dp.lastSeenAt} mode="ago" zone={zone} />
                          </>
                        ) : null}
                      </span>
                    </span>
                    <StatusChip tone={dp.voidReason === 'overshared' ? 'danger' : TONE[dp.state]}>
                      {dp.voidReason ? D.reason[dp.voidReason] : D.state[dp.state]}
                    </StatusChip>
                    {dp.state === 'pending' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => run({ kind: 'code', id: dp.id }, title)}
                      >
                        {D.newCode}
                      </Button>
                    ) : null}
                    {live ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:not-disabled:text-danger"
                        iconStart={<Ban aria-hidden />}
                        aria-expanded={asking === dp.id}
                        onClick={() => setAsking(asking === dp.id ? null : dp.id)}
                      >
                        {D.void}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={full || blocked}
                        onClick={() => run({ kind: 'again', id: dp.id }, title)}
                      >
                        {D.again}
                      </Button>
                    )}
                  </div>
                  {asking === dp.id && live ? (
                    <section className="wb-pass-void" aria-label={D.voidTitle}>
                      <p className="text-sm font-medium text-fg-strong">{D.voidTitle}</p>
                      <p className="text-sm text-fg-muted">{D.voidLine}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={() => setAsking(null)}>
                          {D.cancel}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-danger"
                          loading={voidIt.isPending}
                          onClick={() => confirmVoid(dp.id)}
                        >
                          {D.voidConfirm}
                        </Button>
                      </div>
                    </section>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {shown ? (
        <DevicePassDialog
          pass={{
            ...shown.pass,
            state: items.find((i) => i.id === shown.pass.id)?.state ?? shown.pass.state,
          }}
          title={shown.title}
          active={active}
          limit={limit}
          busy={make.isPending}
          onNewCode={() => run({ kind: 'code', id: shown.pass.id }, shown.title)}
          onClose={() => setShown(null)}
        />
      ) : null}
    </div>
  );
}
