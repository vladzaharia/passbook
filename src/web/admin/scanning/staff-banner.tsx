import { Plus } from 'lucide-react';
import { Button } from '@/web/ui/index.ts';

/** What the Staff counts mean, and the bulk actions beside it. */
export function StaffBanner({
  mode,
  actions,
  onUntagged,
  onCreate,
}: {
  mode: 'live' | 'test';
  actions: boolean;
  onUntagged: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-surface-raised p-4">
      <p className="text-sm text-fg-muted">
        Shared by Live and Test. Counts show {mode === 'test' ? 'Test' : 'Live'} scans today, not
        undone.
      </p>
      {actions ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onUntagged}>
            Reset untagged PINs
          </Button>
          <Button iconStart={<Plus aria-hidden />} onClick={onCreate}>
            Add staff
          </Button>
        </div>
      ) : null}
    </div>
  );
}
