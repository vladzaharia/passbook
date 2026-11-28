import { QrCode } from 'lucide-react';
import { useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import type { StoredSurface } from '@/shared/scan-surfaces.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { FormField, Input, useWizard, WizardDialog } from '@/web/ui/index.ts';
import { type Pairing, PairingFace } from '../pairing-face.tsx';
import { useAddSessionDevice } from './api.ts';
import { SurfacePicker } from './surface-picker.tsx';

/** `base`, else `base 2`, `base 3`... cut to the 40 characters a device name takes. */
export function freeName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` ${n}`;
    const name = `${base.slice(0, 40 - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

const STEPS = [{ id: 'device', title: 'Device', heading: 'Name the device' }] as const;

export function AddDeviceDialog({
  session,
  onClose,
  setup = false,
  deviceNames = [],
}: {
  session: ScanningSession;
  onClose: () => void;
  /** Opened right after Scan passes: the first scanner, named and ready to pair. */
  setup?: boolean;
  /** Names taken in this session: the first scanner name is a free one. */
  deviceNames?: string[];
}) {
  const [name, setName] = useState(() =>
    setup ? freeName(`${session.name} scanner`, deviceNames) : '',
  );
  // A name the dialog picked, not typed: another session's scanner may hold it, so try the next.
  const [auto, setAuto] = useState(setup);
  const [surface, setSurface] = useState<StoredSurface>('auto');
  const [made, setMade] = useState<{ id: string; name: string; pairing: Pairing | null }>();
  const add = useAddSessionDevice(session.id);
  async function submit() {
    const tried = [...deviceNames];
    let next = name.trim();
    for (let attempt = 0; ; attempt++) {
      try {
        setMade(
          await add.mutateAsync({
            name: next,
            ...(surface === 'customer' || surface === 'desk'
              ? { deviceRole: 'customer' }
              : { surface }),
          }),
        );
        return;
      } catch (cause) {
        if (auto && attempt < 20 && isApiError(cause) && cause.code === 'SCANNER_NAME_TAKEN') {
          tried.push(next);
          next = freeName(`${session.name} scanner`, tried);
          setName(next);
          continue;
        }
        throw cause;
      }
    }
  }
  const w = useWizard({
    open: true,
    steps: STEPS,
    errors: { device: name.trim() ? undefined : { name: 'Name the device.' } },
    hints: { device: 'Name the device.' },
    fieldStep: { name: 'device', surface: 'device' },
    onFinish: submit,
  });
  return (
    <WizardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={setup ? 'Pair a scanner' : 'Add device'}
      wizard={w}
      dirty={!made && !!name && !setup}
      finishLabel="Create pairing code"
      busy={add.isPending}
      result={
        made?.pairing
          ? {
              title: `Pair ${made.name}`,
              icon: <QrCode aria-hidden />,
              body: (
                <PairingFace
                  scanner={{ ...made, mode: session.mode }}
                  pairing={made.pairing}
                  onClose={onClose}
                />
              ),
            }
          : undefined
      }
    >
      <FormField label="Device name" required error={w.errors.name}>
        {(p) => (
          <Input
            {...p}
            data-autofocus
            value={name}
            onChange={(e) => {
              setAuto(false);
              setName(e.target.value);
            }}
            placeholder="Front desk iPad"
            maxLength={40}
            autoComplete="off"
          />
        )}
      </FormField>
      <SurfacePicker value={surface} onChange={setSurface} />
    </WizardDialog>
  );
}
