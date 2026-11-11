import { LockKeyhole } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import type { Json, ScanRole } from '@/passkit/types.ts';
import type { Mode } from '@/shared/contracts/common.ts';
import type { ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import { SegmentedControl, Select } from '@/web/ui/index.ts';
import type { DesignDoc } from '../model.ts';
import { StageDiagnostics } from './scan-stage-diagnostics.tsx';
import { useStageFocus } from './scan-stage-focus.ts';
import { useStagePreview } from './scan-stage-model.ts';
import { RealPassPicker } from './scan-stage-pass.tsx';
import { PreviewCard } from './scan-stage-preview-card.tsx';
import type { HitState } from './scan-stage-preview-hit.tsx';
import { SampleInputs, useRealPreview } from './scan-stage-samples.tsx';
import type { ScanStageAction } from './scan-stage-types.ts';
import '@/web/scan/display/display.css';
import '@/web/scan/display/display-rows.css';
import '@/web/scan/result/result.css';
import '@/web/scan/result/identity.css';
import './scan-stage-controls.css';
import './scan-stage.css';

export type { ScanStageAction } from './scan-stage-types.ts';

interface ScanStageProps {
  doc: DesignDoc;
  display: ScanDisplayDoc | null;
  templateId: string;
  orgId: string | null;
  mode: Mode;
  screen: ScanDisplayScreen;
  onScreenChange: (screen: ScanDisplayScreen) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onAction?: (id: string, action: ScanStageAction) => void;
  phone: boolean;
}

export function ScanStage({
  doc,
  display,
  templateId,
  orgId,
  mode,
  screen,
  onScreenChange,
  selected,
  onSelect,
  onAction,
  phone,
}: ScanStageProps) {
  const [role, setRole] = useState<ScanRole>('door');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [device, setDevice] = useState<'phone' | 'ipad'>('phone');
  const [source, setSource] = useState<'synthetic' | 'real'>('synthetic');
  const [passId, setPassId] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, Json>>({});
  const [tabId, setTabId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const real = useRealPreview(
    orgId,
    templateId,
    mode,
    role,
    source === 'real' && orgId ? passId : null,
    request,
  );
  const {
    actions,
    tabs,
    tab,
    invalidDisplay,
    synthetic,
    usingReal,
    rendered,
    cuts,
    fit,
    hiddenPanels,
  } = useStagePreview({ doc, display, screen, tabId, role, now, overrides, source, real });
  useEffect(() => {
    if (tab.screen !== screen) onScreenChange(tab.screen);
  }, [tab.screen, screen, onScreenChange]);
  const { focusId, setFocusId, canvas, onCanvasKey, chooseTab, onTabsKey } = useStageFocus({
    selected,
    tab,
    tabs,
    role,
    usingReal,
    phone,
    onAction,
    onScreenChange,
    setTabId,
  });
  const hit: HitState = { selected, active: focusId, onSelect, onFocus: setFocusId, phone };
  return (
    <section className="sp-stage" aria-label="Scan screen preview controls">
      <div className="sp-tabs" role="tablist" aria-label="Preview outcome" onKeyDown={onTabsKey}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            tabIndex={item.id === tab.id ? 0 : -1}
            aria-selected={item.id === tab.id}
            className="sp-tab"
            data-screen={item.screen}
            onClick={() => chooseTab(item)}
          >
            <span className="sp-tab-dot" aria-hidden />
            {item.label}
            {item.screen === 'refused' ? <LockKeyhole size={14} aria-hidden /> : null}
          </button>
        ))}
      </div>
      <div className="sp-controls">
        <SegmentedControl
          label="Preview role"
          options={
            [
              { value: 'door', label: 'Door' },
              { value: 'desk', label: 'Desk' },
              { value: 'manager', label: 'Manager' },
            ] as const
          }
          value={role}
          onValueChange={(next) => {
            real.discard();
            setRole(next);
            setOverrides({});
          }}
        />
        <SegmentedControl
          label="Preview theme"
          options={
            [
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ] as const
          }
          value={theme}
          onValueChange={setTheme}
        />
        <SegmentedControl
          label="Preview device"
          options={
            [
              { value: 'phone', label: 'Phone' },
              { value: 'ipad', label: 'iPad' },
            ] as const
          }
          value={device}
          onValueChange={setDevice}
        />
      </div>
      <div className="sp-sample-controls">
        <Select
          label="Sample"
          value={orgId ? source : 'synthetic'}
          options={[
            { value: 'synthetic', label: 'Synthetic sample' },
            { value: 'real', label: 'Real pass', disabled: !orgId },
          ]}
          onValueChange={(value) => {
            real.discard();
            setPassId(null);
            setSource(value as 'synthetic' | 'real');
          }}
        />
        {source === 'real' && orgId ? (
          <RealPassPicker
            passId={passId}
            error={real.error}
            onPick={(id) => {
              real.discard();
              setPassId(id);
              setRequest((n) => n + 1);
            }}
            onRetry={() => {
              real.discard();
              setRequest((n) => n + 1);
            }}
          />
        ) : null}
      </div>
      <p className="sp-source" role="status">
        {usingReal
          ? 'Real pass · filtered for the selected role'
          : source === 'real' && orgId && passId && real.status !== 'error'
            ? 'Loading real pass · showing a synthetic sample'
            : source === 'real' && orgId && real.status === 'error'
              ? 'Real pass unavailable · showing a synthetic sample'
              : 'Synthetic sample · not a real pass'}
      </p>
      {!usingReal && synthetic?.previewRestricted === true ? (
        <p className="sp-help">
          Some synthetic inputs and lookups are omitted to protect restricted data.
        </p>
      ) : null}
      {!orgId ? <p className="sp-help">Real-pass preview needs an organization.</p> : null}
      {source === 'synthetic' && !phone ? (
        <details className="sp-sample-editor">
          <summary>Edit synthetic sample inputs</summary>
          <SampleInputs
            doc={doc}
            role={role}
            overrides={overrides}
            onChange={setOverrides}
            scope={synthetic}
          />
        </details>
      ) : null}
      <fieldset
        ref={canvas}
        className="sp-canvas"
        aria-label={`Scan screen preview, ${tab.label}`}
        onKeyDown={onCanvasKey}
      >
        <div className="sp-device" data-device={device} data-theme={theme}>
          <div className="sp-device-notch" aria-hidden />
          {rendered ? (
            <PreviewCard
              rendered={rendered}
              tab={tab}
              actions={actions}
              hit={hit}
              hiddenPanels={hiddenPanels}
              role={role}
            />
          ) : (
            <p className="sp-error" role="alert">
              {invalidDisplay
                ? 'The authored scan screen is invalid. Correct or replace it before previewing.'
                : 'This scan screen cannot be previewed until its invalid fields are corrected.'}
            </p>
          )}
        </div>
      </fieldset>
      <StageDiagnostics fit={fit} cuts={cuts} phone={phone} onSelect={onSelect} />
    </section>
  );
}
