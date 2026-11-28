import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { errorMessage } from '../lib/errors.ts';
import type { ScanApi } from './api/scan-api.ts';
import type { useTagUi } from './assign/use-tag-ui.tsx';
import { ScanHardware } from './hardware/hardware-control.tsx';
import type { MachineEvent } from './machine/access-events.ts';
import type { ScanState } from './machine/types.ts';
import { saveDevicePref } from './platform/device-prefs.ts';
import { canBuzz } from './platform/haptics.ts';
import type { ScanRuntime } from './platform/runtime.ts';
import { type CameraChoice, ScanMenu } from './ui/scan-menu.tsx';
import type { ScanPanel } from './ui/scan-overlays.tsx';

/** The scanner menu wired to the loop (prefs, camera, staff, mode, shift, leave), with the hardware pill before it. */
export function LoopMenu(p: {
  s: ScanState;
  session: ScanSession;
  api: ScanApi;
  runtime: ScanRuntime;
  tags: ReturnType<typeof useTagUi>;
  dispatch: (event: MachineEvent) => void;
  refetch: () => Promise<void>;
  leave: () => void;
  operator: boolean;
  duoLayout: boolean;
  readerUsable: boolean;
  cameraChoice: CameraChoice;
  setCameraChoice: (choice: CameraChoice) => void;
  setCameraError: (message: string) => void;
  showPanel: (panel: ScanPanel) => void;
}) {
  const { s, session, api, runtime, dispatch, refetch } = p;
  const setPref = (key: 'sunlight' | 'leftHand', value: boolean) => {
    saveDevicePref(key, value);
    dispatch({ type: 'prefs', prefs: { [key]: value } });
  };
  const menu = (
    <ScanMenu
      sound={s.prefs.sound}
      onSound={(value) => dispatch({ type: 'prefs', prefs: { sound: value } })}
      holdResults={s.prefs.holdResults}
      onHoldResults={(value) => dispatch({ type: 'prefs', prefs: { holdResults: value } })}
      handheld={{
        sunlight: s.prefs.sunlight,
        leftHand: s.prefs.leftHand,
        onSunlight: (value: boolean) => setPref('sunlight', value),
        onLeftHand: (value: boolean) => setPref('leftHand', value),
        canBuzz: canBuzz(),
      }}
      camera={p.cameraChoice}
      cameraAvailable={!p.operator || p.duoLayout}
      canSwitchStaff={Boolean(session.staff)}
      onSwitchStaff={() =>
        void api.staffSignOut().then(refetch, (error) => p.setCameraError(errorMessage(error)))
      }
      flip={session.scanner?.kind === 'device' ? { api, refetch } : undefined}
      hasWide={runtime.camera.hasWide()}
      onCamera={(choice) => {
        p.setCameraChoice(choice);
        runtime.camera.choose(choice);
      }}
      tags={p.tags.menu}
      hasReader={p.readerUsable}
      cameraOff={s.camera === 'disabled'}
      onCameraOff={(off) => {
        if (off) runtime.camera.stop();
        dispatch({ type: 'camera', status: off ? 'disabled' : 'off' });
        if (!off && s.started) runtime.camera.start();
      }}
      onReaderTips={() => p.showPanel('tips')}
      onShift={() => p.showPanel('shift')}
      onEndShift={() => p.showPanel('end')}
      leave={session.principal === 'admin' ? 'stop-admin' : 'unpair'}
      onLeave={p.leave}
    />
  );
  return (
    <>
      <ScanHardware
        {...{ runtime, s }}
        lens={[p.cameraChoice, p.setCameraChoice]}
        camera={!p.operator || p.duoLayout}
        readerUsable={p.readerUsable}
      />
      {menu}
    </>
  );
}
