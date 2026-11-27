import { Ban, Clock, ExternalLink, Tag } from 'lucide-react';
import { DEVICE_PASS_MAX_ACTIVE, type DevicePassDto } from '@/shared/contracts/device-passes.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { Button } from '../../ui/button.tsx';
import { Dialog, DialogContent } from '../../ui/dialog.tsx';
import { ProgressBar } from '../../ui/progress-bar.tsx';
import { useNow } from '../../ui/rel-time.tsx';
import { absoluteUrl } from '../ui/preview-qr.tsx';
import { QrTile } from '../ui/qr-tile.tsx';

const D = WB_PASSES.device;
const FACT_ICONS = [Tag, Ban, Clock];

const clock = (ms: number): string => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The one-time code of a device pass (design §3.4): the QR with one sweep, the code's 10 minutes, the three
 * facts and the meter. Below 640 px the phone in hand is the phone, so the QR gives way to Open on this phone.
 */
export function DevicePassDialog({
  pass,
  title,
  active,
  limit,
  busy,
  onNewCode,
  onClose,
}: {
  pass: DevicePassDto;
  title: string;
  active: number;
  limit: number;
  busy: boolean;
  onNewCode: () => void;
  onClose: () => void;
}) {
  const code = pass.code;
  const now = useNow(1000, code !== null);
  const left = code ? code.expiresAt - now : 0;
  const link = code ? absoluteUrl(code.url) : '';
  const live = code !== null && left > 0;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={D.title}
        size="sm"
        footer={
          <>
            {pass.state === 'pending' ? (
              <Button variant="ghost" loading={busy} onClick={onNewCode}>
                {D.newCode}
              </Button>
            ) : null}
            <Button onClick={onClose}>{D.done}</Button>
          </>
        }
      >
        <div className="flex min-w-0 flex-col items-center gap-4">
          {live ? (
            <>
              <span className="wb-device-qr max-sm:hidden">
                <QrTile value={link} alt={D.qrAlt(title)} />
                <i aria-hidden className="wb-device-sweep" />
              </span>
              <Button
                asChild
                size="lg"
                className="w-full sm:hidden"
                iconStart={<ExternalLink aria-hidden />}
              >
                <a href={link} target="_blank" rel="noreferrer">
                  {D.open}
                </a>
              </Button>
            </>
          ) : null}
          <p className="flex items-center gap-2 font-mono text-xs text-fg-muted">
            <Clock className="size-3.5" aria-hidden />
            {live ? `${D.once} · ${clock(left)}` : D.expired}
          </p>
          <ul className="flex w-full flex-col gap-2 border-t border-border pt-3 text-sm text-fg">
            {D.facts.map((fact, i) => {
              const Icon = FACT_ICONS[i] ?? Tag;
              return (
                <li key={fact} className="flex items-center gap-2">
                  <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
                  {fact}
                </li>
              );
            })}
          </ul>
          <div className="flex w-full items-center gap-3 text-xs text-fg-muted">
            <span className="shrink-0">{D.used(active, limit || DEVICE_PASS_MAX_ACTIVE)}</span>
            <ProgressBar
              label={D.meter}
              value={active}
              max={limit || DEVICE_PASS_MAX_ACTIVE}
              valueText={D.used(active, limit || DEVICE_PASS_MAX_ACTIVE)}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
