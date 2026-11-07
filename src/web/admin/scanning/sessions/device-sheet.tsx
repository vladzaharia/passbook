import { QrCode, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { ScanningDevice, ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { DiscardDialog } from '@/web/ui/alert-dialog.tsx';
import { Badge, Button, Callout, FormField, Input, Sheet, SheetContent } from '@/web/ui/index.ts';
import { useUpdateSessionDevice } from './api.ts';
import { DeviceOverrides } from './device-overrides.tsx';
import { SurfacePicker } from './surface-picker.tsx';

export function DeviceSheet({
  device,
  session,
  onClose,
  onPair,
  onRevoke,
}: {
  device: ScanningDevice;
  session: ScanningSession;
  onClose: () => void;
  onPair: () => void;
  onRevoke: () => void;
}) {
  const [discard, setDiscard] = useState(false);
  const [name, setName] = useState(device.name);
  const [surface, setSurface] = useState(device.surface);
  const [overrides, setOverrides] = useState(device.overrides);
  const [revision, setRevision] = useState(device.updatedAt);
  const [error, setError] = useState('');
  const save = useUpdateSessionDevice(session.id, device.id);
  const changed = device.updatedAt !== revision;
  const dirty =
    name !== device.name ||
    surface !== device.surface ||
    JSON.stringify(overrides) !== JSON.stringify(device.overrides);
  const layout = surface === 'desk' ? 'operator' : surface;
  async function submit() {
    setError('');
    try {
      await save.mutateAsync({ name: name.trim(), surface, overrides, revision });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) {
            if (dirty) setDiscard(true);
            else onClose();
          }
        }}
      >
        <SheetContent title={`Configure ${device.name}`} className="sm:w-[440px]">
          <div className="grid gap-6 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={device.online && !device.revoked ? 'success' : 'neutral'}>
                {device.revoked
                  ? 'Revoked'
                  : device.online
                    ? 'Online'
                    : device.paired
                      ? 'Offline'
                      : 'Needs pairing'}
              </Badge>
              <Badge>{device.signIn === 'admin' ? 'Administrator sign-in' : 'Paired device'}</Badge>
            </div>
            {device.capabilities ? (
              <div className="grid gap-2 text-sm">
                <p className="font-medium text-fg-strong">
                  {device.capabilities.width} × {device.capabilities.height} viewport
                </p>
                <div className="flex flex-wrap gap-2">
                  {device.capabilities.camera === 'available' ? <Badge>Camera</Badge> : null}
                  {device.capabilities.keyboard ? <Badge>Keyboard input</Badge> : null}
                  {device.capabilities.nativeBarcode ? <Badge>Android barcode reader</Badge> : null}
                  {device.capabilities.touch ? <Badge>Touch</Badge> : null}
                </div>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">
                Waiting for this device to report its screen and inputs.
              </p>
            )}
            {changed || error ? (
              <Callout tone={changed ? 'warning' : 'danger'}>
                {changed ? 'Device settings changed elsewhere.' : error}
                <Button
                  variant="link"
                  onClick={() => {
                    setName(device.name);
                    setSurface(device.surface);
                    setOverrides(device.overrides);
                    setRevision(device.updatedAt);
                    setError('');
                  }}
                >
                  Reload settings
                </Button>
              </Callout>
            ) : null}
            <FormField label="Device name" required>
              {(p) => (
                <Input
                  {...p}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={40}
                />
              )}
            </FormField>
            <SurfacePicker
              value={surface}
              onChange={setSurface}
              capabilities={device.capabilities}
            />
            {layout !== 'customer' ? (
              <section className="grid gap-4 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">Device overrides</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!Object.keys(overrides).length}
                    iconStart={<RotateCcw aria-hidden />}
                    onClick={() => setOverrides({})}
                  >
                    Reset
                  </Button>
                </div>
                <p className="text-xs text-fg-muted">
                  These settings inherit from the session unless changed here.
                </p>
                <DeviceOverrides value={overrides} onChange={setOverrides} session={session} />
              </section>
            ) : (
              <p className="text-sm text-fg-muted">
                This display follows scanners in the same session and cannot check anyone in.
              </p>
            )}
            <div className="sticky bottom-0 grid gap-3 border-t border-border bg-surface-raised py-4">
              <Button
                loading={save.isPending}
                disabled={!dirty || !name.trim() || changed || device.revoked}
                onClick={() => void submit()}
              >
                Save device
              </Button>
              {device.signIn === 'paired' && !device.revoked ? (
                <Button variant="outline" iconStart={<QrCode aria-hidden />} onClick={onPair}>
                  {device.paired ? 'Pair again' : 'Pair device'}
                </Button>
              ) : null}
              {!device.revoked ? (
                <Button variant="ghost" className="text-danger" onClick={onRevoke}>
                  Revoke device
                </Button>
              ) : null}
            </div>
          </div>
        </SheetContent>
      </Sheet>
      <DiscardDialog open={discard} onOpenChange={setDiscard} onDiscard={onClose} />
    </>
  );
}
