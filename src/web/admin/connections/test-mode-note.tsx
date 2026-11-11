import { setMode, useMode } from '@/web/lib/mode.ts';
import { Button, Callout } from '@/web/ui/index.ts';

/** The Test view does not isolate shared connection operations from Live. */
export function TestModeNote({ className }: { className?: string }) {
  if (useMode() !== 'test') return null;
  return (
    <Callout
      className={className}
      actions={
        <Button size="sm" variant="outline" onClick={() => setMode('live')}>
          Turn off Test mode
        </Button>
      }
    >
      Connections are shared between Live and Test. Changes, tests and syncs can affect live data;
      connections create live passes, which are hidden in Test view.
    </Callout>
  );
}

/** Opening a connection's passes from Test mode switches to Live, where they are. */
export const showLive = () => setMode('live');
