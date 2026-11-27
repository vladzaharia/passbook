import { Wrench } from 'lucide-react';
import { BRIDGE_COPY } from '@/shared/copy/workbench-bridge.ts';
import type { WbPathOptions, WbTool } from '@/shared/workbench.ts';
import { useWorkbenchBridge } from '../../lib/workbench-bridge.ts';
import { Button } from '../button.tsx';
import { ModeLabel } from './mode-label.tsx';

/**
 * "Open in Workbench" with its Test tag, on a record's header (design §2.4). The Workbench never
 * runs Live, so in Live the link and its tag are gone; the sidebar entry stays.
 */
export function OpenInWorkbench({ tool, options }: { tool: WbTool; options?: WbPathOptions }) {
  const bridge = useWorkbenchBridge();
  if (!bridge?.records) return null;
  return (
    <Button asChild variant="outline" iconStart={<Wrench aria-hidden />}>
      <a href={bridge.href(tool, options)}>
        {BRIDGE_COPY.open}
        <ModeLabel mode="test" />
      </a>
    </Button>
  );
}
