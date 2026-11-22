import type { ReactNode } from 'react';
import { SegmentedControl } from '../../ui/index.ts';

export type PreviewView = 'live' | 'draft';

const VIEWS = [
  { value: 'live', label: 'Live' },
  { value: 'draft', label: 'Draft' },
] as const;

/** Live or Draft under the pass, once a newer draft exists. */
export function PreviewToggle({
  view,
  onView,
  children,
}: {
  view: PreviewView;
  onView: (view: PreviewView) => void;
  children: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-3">
      {children}
      <SegmentedControl
        label="Preview"
        options={VIEWS}
        value={view}
        onValueChange={(v) => onView(v === 'live' ? 'live' : 'draft')}
      />
    </div>
  );
}
