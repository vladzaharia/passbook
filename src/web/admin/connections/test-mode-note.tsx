import { setMode, useMode } from '@/web/lib/mode.ts';
import { Button, Callout } from '@/web/ui/index.ts';

/** Connections create live passes, so Test mode hides what they made. */
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
      Connections always make live passes. Turn off Test mode to see them.
    </Callout>
  );
}

/** Opening a connection's passes from Test mode switches to Live, where they are. */
export const showLive = () => setMode('live');
