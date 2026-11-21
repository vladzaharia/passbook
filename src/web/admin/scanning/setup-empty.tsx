import { Plus } from 'lucide-react';
import { Buddy, Button, EntityArt } from '@/web/ui/index.ts';
import { PresetTiles } from './setup/preset-tiles.tsx';

/**
 * Scanning with no sessions: the buddy waves once, three ways to start, and Start blank (today's
 * New session). Without manage rights only the sentence shows.
 */
export function SetupEmpty({
  orgId,
  canManage,
  onBlank,
}: {
  orgId: string;
  canManage: boolean;
  onBlank: () => void;
}) {
  return (
    <div
      data-art-host=""
      className="relative flex flex-col items-center gap-4 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center"
    >
      <div aria-hidden className="relative mt-[4.5rem] mb-1 h-0 w-full">
        <Buddy mood="happy" scene="wave" prop={<EntityArt name="scanner" size="sm" />} />
      </div>
      <h2 className="text-lg font-semibold text-fg-strong">
        {canManage ? 'Set up scanning' : 'No scanning sessions'}
      </h2>
      {canManage ? (
        <>
          <PresetTiles orgId={orgId} />
          <Button variant="ghost" iconStart={<Plus aria-hidden />} onClick={onBlank}>
            Start blank
          </Button>
        </>
      ) : null}
    </div>
  );
}
