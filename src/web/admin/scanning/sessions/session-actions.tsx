import { Copy, Pause, Play, QrCode, ScanLine, Square } from 'lucide-react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { Button, DropdownMenuItem, MoreMenu, toast } from '@/web/ui/index.ts';
import { useUpdateSession } from './api.ts';

/**
 * The header's actions: Pair devices, Scan as Admin, and More (Pause, Duplicate, End).
 * Pair devices opens the add-device dialog until the rolling pairing sheet lands.
 */
export function SessionActions({
  session: s,
  onPair,
  onDuplicate,
  onEnd,
}: {
  session: ScanningSession;
  onPair: () => void;
  onDuplicate: () => void;
  onEnd: () => void;
}) {
  const update = useUpdateSession(s.id);
  const active = s.status === 'active';
  async function change(status: 'active' | 'paused') {
    try {
      await update.mutateAsync({ status, revision: s.updatedAt });
    } catch (error) {
      toast.error(error, 'Could not change session');
    }
  }
  return (
    <>
      <Button iconStart={<QrCode aria-hidden />} disabled={!active} onClick={onPair}>
        Pair devices
      </Button>
      <Button variant="outline" iconStart={<ScanLine aria-hidden />} disabled={!active} asChild>
        <a
          href={`/scan?admin=1&orgId=${encodeURIComponent(s.orgId)}&sessionId=${encodeURIComponent(s.id)}`}
        >
          Scan as Admin
        </a>
      </Button>
      <MoreMenu>
        {s.status !== 'ended' ? (
          <DropdownMenuItem onSelect={() => void change(active ? 'paused' : 'active')}>
            {active ? <Pause aria-hidden /> : <Play aria-hidden />}
            {active ? 'Pause' : 'Resume'}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onDuplicate}>
          <Copy aria-hidden />
          Duplicate
        </DropdownMenuItem>
        {s.status !== 'ended' ? (
          <DropdownMenuItem destructive onSelect={onEnd}>
            <Square aria-hidden />
            End
          </DropdownMenuItem>
        ) : null}
      </MoreMenu>
    </>
  );
}
