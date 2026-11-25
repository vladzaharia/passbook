import { FlaskConical } from 'lucide-react';
import { setMode, useMode } from '../../lib/mode.ts';
import { TEST_NOTE } from './mode-copy.ts';
import { SegmentedControl } from '../segmented-control.tsx';

/** Live or Test, in the top bar. Test-only orgs never render it. */
export function ModeSwitch() {
  const mode = useMode();
  return (
    <SegmentedControl
      label="Mode"
      value={mode}
      onValueChange={setMode}
      // On a phone the bar is full: no icon, tighter segments.
      className="max-[28rem]:[&_svg]:hidden max-[28rem]:[&>[role=radio]]:px-2!"
      options={[
        { value: 'live', label: 'Live' },
        {
          value: 'test',
          label: 'Test',
          icon: FlaskConical,
          description: TEST_NOTE,
        },
      ]}
    />
  );
}
