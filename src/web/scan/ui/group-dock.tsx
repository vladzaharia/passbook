import { Users } from 'lucide-react';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import { DockButton } from './dock.tsx';

/** Under an ok card with people left in the bundle: one tap checks them in, no confirm (handheld design 15.2). */
export function GroupDock({ label }: { label: string }) {
  const { dispatch } = useScanMachine();
  return (
    <>
      <DockButton
        primary
        variant="filled"
        data-testid="dock-group"
        onClick={() => dispatch({ type: 'group' })}
      >
        <Users aria-hidden size={20} />
        {label}
      </DockButton>
      <DockButton shape="fixed" onClick={() => dispatch({ type: 'dismiss' })}>
        Done
      </DockButton>
    </>
  );
}
