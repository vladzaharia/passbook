import { Siren } from 'lucide-react';
import { Button } from '../../ui/button.tsx';
import { ACCESS_COPY } from '../ui/copy-access.ts';

/** The strip under Who's in: Desk and above start a roll call from here. */
export function StartRollCallFooter({
  disabled,
  onStart,
}: {
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <footer className="scan-in-foot">
      <Button
        variant="danger"
        className="scan-in-start"
        disabled={disabled}
        iconStart={<Siren aria-hidden />}
        onClick={onStart}
      >
        {ACCESS_COPY.roll.start}
      </Button>
    </footer>
  );
}
