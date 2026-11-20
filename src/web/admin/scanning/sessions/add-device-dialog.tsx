import { useState } from 'react';
import type { ScanningDevice, ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, Callout, Dialog, DialogContent, FormField, Input } from '@/web/ui/index.ts';
import { type Pairing, PairingFace } from '../pairing-face.tsx';
import { useAddSessionDevice } from './api.ts';
import { SurfacePicker } from './surface-picker.tsx';

export function AddDeviceDialog({
  session,
  onClose,
  setup = false,
}: {
  session: ScanningSession;
  onClose: () => void;
  /** Opened right after Scan passes: the first scanner, named and ready to pair. */
  setup?: boolean;
}) {
  const [name, setName] = useState(setup ? `${session.name} scanner`.slice(0, 40) : '');
  const [surface, setSurface] = useState<ScanningDevice['surface']>('auto');
  const [error, setError] = useState('');
  const [made, setMade] = useState<{ id: string; name: string; pairing: Pairing | null }>();
  const add = useAddSessionDevice(session.id);
  async function submit() {
    setError('');
    try {
      setMade(await add.mutateAsync({ name: name.trim(), surface }));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} dirty={!made && !!name && !setup}>
      <DialogContent
        title={made ? `Pair ${made.name}` : setup ? 'Pair a scanner' : 'Add device'}
        size="lg"
        description={
          made
            ? undefined
            : setup
              ? `Name the device that will scan at ${session.name}.`
              : `Add a scanner, operator or display to ${session.name}.`
        }
        footer={
          made ? undefined : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!name.trim()} loading={add.isPending} onClick={() => void submit()}>
                Create pairing code
              </Button>
            </>
          )
        }
      >
        {made?.pairing ? (
          <PairingFace
            scanner={{ ...made, mode: session.mode }}
            pairing={made.pairing}
            onClose={onClose}
          />
        ) : (
          <div className="grid gap-6">
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <FormField label="Device name" required>
              {(p) => (
                <Input
                  {...p}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Front desk iPad"
                  maxLength={40}
                  autoComplete="off"
                />
              )}
            </FormField>
            <SurfacePicker value={surface} onChange={setSurface} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
