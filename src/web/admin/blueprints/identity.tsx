import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { blueprintGlyph } from './glyph.ts';
import { blueprintVars } from './identity.ts';
import './blueprints.css';

/** The icon tile in the pass's colours; 36 px on tiles, 48 px in the page header. */
export function BlueprintGlyph({
  icon: Icon,
  size = 36,
  className,
}: {
  icon: LucideIcon;
  size?: 36 | 48;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn('bp-glyph', className)} data-size={size}>
      <Icon />
    </span>
  );
}

/** Page header avatar: the glyph at 48 px in the blueprint's own colours. */
export function BlueprintAvatar({
  icon,
  passJson,
}: {
  icon: string | null;
  passJson: Record<string, unknown> | undefined;
}) {
  return (
    <span className="bp-avatar inline-flex" style={blueprintVars(passJson)}>
      <BlueprintGlyph icon={blueprintGlyph({ icon })} size={48} />
    </span>
  );
}

/** The drafting grid with the glow underneath, around the detail page's pass. */
export function BlueprintStage({
  passJson,
  children,
}: {
  passJson: Record<string, unknown> | undefined;
  children: ReactNode;
}) {
  return (
    <div className="bp-hero" style={blueprintVars(passJson)}>
      <div className="bp-stage rounded-lg" data-size="lg">
        {children}
      </div>
    </div>
  );
}
