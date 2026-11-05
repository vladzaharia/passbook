import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import { cn } from '../../lib/cn.ts';
import { DisplayPanel } from './panel.tsx';
import './display.css';

/**
 * Paints a rendered `ScanDisplay`'s panels. It never renders a button, and a refused screen
 * paints no panels even if the payload carries some (defence in depth). The result card, the
 * desk panel and the designer canvas all use this one painter.
 */
export function DisplayPanels({
  display,
  className,
}: {
  display: ScanDisplay;
  className?: string;
}) {
  if (display.screen === 'refused' || display.panels.length === 0) return null;
  return (
    <div className={cn('sd', className)}>
      {display.panels.map((panel) => (
        <DisplayPanel key={panel.id} panel={panel} />
      ))}
    </div>
  );
}
