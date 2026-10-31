import type { PassView } from '../../shared/pass-view/index.ts';

/** Workstream b owns this module. Keep `PassCard` and `PassCardProps` exported; must be SSR-safe. */
export interface PassCardProps {
  view: PassView;
  face?: 'front' | 'back';
  className?: string;
}

export function PassCard({ view, face = 'front', className }: PassCardProps) {
  return (
    <div className={className} data-face={face} data-style={view.style}>
      {view.organizationName}
    </div>
  );
}
