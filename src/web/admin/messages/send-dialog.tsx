import { useState } from 'react';
import { Button, Dialog, DialogContent, toast } from '../../ui/index.ts';
import { WhenSection } from './compose-sections.tsx';
import { atMs, type ComposerState, INITIAL } from './composer-state.ts';

/** Sends a saved draft now, or at a time. */
export function SendDialog({
  open,
  onOpenChange,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (at: number | undefined) => Promise<void>;
}) {
  const [state, setState] = useState<ComposerState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const at = atMs(state);
  const later = state.when === 'later';
  const error =
    later && (at === undefined || at <= Date.now()) ? 'Pick a time in the future.' : undefined;
  const submit = async () => {
    if (error) return;
    setBusy(true);
    try {
      await onSend(later ? at : undefined);
      onOpenChange(false);
    } catch (cause) {
      toast.error(cause, 'Could not send');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title="Send message"
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={Boolean(error)} onClick={() => void submit()}>
              {later ? 'Schedule' : 'Send now'}
            </Button>
          </>
        }
      >
        <WhenSection state={state} onChange={(p) => setState((s) => ({ ...s, ...p }))} />
      </DialogContent>
    </Dialog>
  );
}
