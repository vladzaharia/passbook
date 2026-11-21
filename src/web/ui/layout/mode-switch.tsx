import { FlaskConical } from 'lucide-react';
import { setMode, useMode } from '../../lib/mode.ts';
import { SegmentedControl } from '../segmented-control.tsx';

/** Live or Test, in the top bar. Test-only orgs never render it. */
export function ModeSwitch() {
  const mode = useMode();
  return (
    <SegmentedControl
      label="Mode"
      value={mode}
      onValueChange={setMode}
      options={[
        { value: 'live', label: 'Live' },
        { value: 'test', label: 'Test', icon: FlaskConical },
      ]}
    />
  );
}
