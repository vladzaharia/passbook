import { QrCode, RotateCcw } from 'lucide-react';
import { useId, useState } from 'react';
import type { ScanningDevice } from '@/shared/contracts/scanning-sessions.ts';
import { surfaceFor } from '@/shared/scan-surfaces.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { DiscardDialog } from '@/web/ui/alert-dialog.tsx';
import {
  Badge,
  Button,
  Callout,
  Form,
  FormField,
  Input,
  Sheet,
  SheetContent,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useUpdateSessionDevice } from './api.ts';
import { DeviceFollows, followable } from './device-follows.tsx';
import { DeviceOverrides } from './device-overrides.tsx';
import { HardwareBadges } from './hardware-badges.tsx';
import type { SessionDetailData } from './session-live.ts';
import { SurfacePicker } from './surface-picker.tsx';

export function DeviceSheet({
  device,
  session,
  canManage,
  onClose,
  onPair,
  onRevoke,
}: {
  device: ScanningDevice;
  session: SessionDetailData;
  canManage: boolean;
  onClose: () => void;
  onPair: () => void;
  onRevoke: () => void;
}) {
  const formId = useId();
  const [discard, setDiscard] = useState(false);
  const [name, setName] = useState(device.name);
  const [surface, setSurface] = useState(device.surface);
  const [overrides, setOverrides] = useState(device.overrides);
  const [revision, setRevision] = useState(device.configRevision);
  const [error, setError] = useState('');
  const save = useUpdateSessionDevice(session.id, device.id);
  const changed = device.configRevision !== revision;
  const dirty =
    name !== device.name ||
    surface !== device.surface ||
    JSON.stringify(overrides) !== JSON.stringify(device.overrides);
  // The surface the server will resolve for this choice and these capabilities.
  const layout = surface === 'desk' ? 'customer' : surfaceFor(surface, device.capabilities);
  const check = useFormErrors({ name: name.trim() ? undefined : 'Enter a name.' });
  async function submit() {
    if (changed || device.revoked || !dirty) return undefined;
    setError('');
    try {
      // A scan surface leaves `follows` out: the server keeps the stored ids, inert, for a flip back.
      const { follows: _follows, ...scanOverrides } = overrides;
      await save.mutateAsync({
        name: name.trim(),
        surface,
        overrides: layout === 'customer' ? overrides : scanOverrides,
        revision,
      });
      onClose();
      return 'saved' as const;
    } catch (cause) {
      setError(errorMessage(cause));
      return 'failed' as const;
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
        <SheetContent
          title={`${canManage ? 'Configure' : 'Device'} ${device.name}`}
          className="sm:w-[440px]"
          footer={
            canManage ? (
              <>
                <Button
                  type="submit"
                  form={formId}
                  loading={save.isPending}
                  disabled={!dirty || changed || device.revoked}
                >
                  Save device
                </Button>
                <div className="grid grid-cols-2 gap-3">
                  {device.signIn === 'paired' && !device.revoked ? (
                    <Button variant="outline" iconStart={<QrCode aria-hidden />} onClick={onPair}>
                      {device.paired ? 'Pair again' : 'Pair device'}
                    </Button>
                  ) : null}
                  {!device.revoked ? (
                    <Button
                      variant="ghost"
                      className="text-danger"
                      aria-label="Revoke device"
                      onClick={onRevoke}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null
          }
        >
          <Form {...check.form} id={formId} className="grid gap-6 p-4" onValid={submit}>
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
              {device.signIn === 'admin' ? <Badge>Administrator sign-in</Badge> : null}
            </div>
            {device.capabilities ? (
              <div className="grid gap-2 text-sm">
                <p className="font-medium text-fg-strong">
                  {device.capabilities.width} × {device.capabilities.height} viewport
                </p>
                <div className="flex flex-wrap gap-2">
                  {device.capabilities.hardware?.length ? (
                    <HardwareBadges hardware={device.capabilities.hardware} />
                  ) : (
                    <>
                      {device.capabilities.camera === 'available' ? <Badge>Camera</Badge> : null}
                      {device.capabilities.nativeBarcode ? (
                        <Badge>Android barcode reader</Badge>
                      ) : null}
                    </>
                  )}
                  {device.capabilities.keyboard ? <Badge>Keyboard input</Badge> : null}
                  {device.capabilities.touch ? <Badge>Touch</Badge> : null}
                  {device.capabilities.draftFailures ? (
                    <Badge tone="warning">
                      Amount drafts failed ×{device.capabilities.draftFailures}
                    </Badge>
                  ) : null}
                  {device.capabilities.native ? (
                    <>
                      <Badge>
                        {device.capabilities.native.platform === 'ios' ? 'iPhone/iPad' : 'Android'}
                      </Badge>
                      {device.capabilities.native.nfc.formats.includes('ndef') ? (
                        <Badge>NDEF tag input</Badge>
                      ) : null}
                      {device.capabilities.native.camera.permission === 'denied' ? (
                        <Badge>Camera access denied</Badge>
                      ) : null}
                      {device.capabilities.native.vas.available ? (
                        <Badge>Wallet pass reader</Badge>
                      ) : null}
                      {device.capabilities.native.nfc.formats.includes('wallet-vas') &&
                      !device.capabilities.native.vas.available ? (
                        <Badge>VAS verification unavailable</Badge>
                      ) : null}
                      {device.capabilities.native.platform === 'ios' &&
                      !device.capabilities.native.vas.available ? (
                        <Badge>Wallet pass reader unavailable</Badge>
                      ) : null}
                      {device.capabilities.native.layout?.posture === 'half-folded' ? (
                        <Badge>Half folded</Badge>
                      ) : device.capabilities.native.layout?.posture === 'unfolded' ? (
                        <Badge>Unfolded</Badge>
                      ) : null}
                      {device.capabilities.native.customerDisplay.active ? (
                        <Badge>Customer display active</Badge>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
            {changed || error ? (
              <Callout tone={changed ? 'warning' : 'danger'}>
                {changed ? 'Device settings changed elsewhere.' : error}
                <Button
                  variant="link"
                  onClick={() => {
                    setName(device.name);
                    setSurface(device.surface);
                    setOverrides(device.overrides);
                    setRevision(device.configRevision);
                    setError('');
                  }}
                >
                  Reload settings
                </Button>
              </Callout>
            ) : null}
            <fieldset disabled={!canManage} className="grid min-w-0 gap-6">
              <legend className="sr-only">Device settings</legend>
              <FormField label="Device name" required error={check.errors.name}>
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
                  <DeviceOverrides value={overrides} onChange={setOverrides} session={session} />
                </section>
              ) : (
                <>
                  <DeviceFollows
                    value={overrides}
                    onChange={setOverrides}
                    scanners={followable(session.devices)}
                  />
                </>
              )}
            </fieldset>
          </Form>
        </SheetContent>
      </Sheet>
      <DiscardDialog open={discard} onOpenChange={setDiscard} onDiscard={onClose} />
    </>
  );
}
