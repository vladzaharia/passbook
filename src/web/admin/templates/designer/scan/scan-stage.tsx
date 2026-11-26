import { LockKeyhole } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { roleAtLeast } from '@/passkit/template/scan-display/scope.ts';
import type { Json, ScanRole } from '@/passkit/types.ts';
import type { Mode } from '@/shared/contracts/common.ts';
import type { ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { ScanPreviewScreen } from '@/web/scan/preview-screen.tsx';
import { CheckboxField, SegmentedControl, Select } from '@/web/ui/index.ts';
import { type DesignDoc, styleOf } from '../model.ts';
import { type FRAME_SIZES, ScanFrame, useFrameLayout } from './scan-frame.tsx';
import { ScanOverlay } from './scan-overlay.tsx';
import { previewOutcome } from './scan-preview-outcome.ts';
import { useOrgLook } from './scan-stage-brand.ts';
import { StageDiagnostics } from './scan-stage-diagnostics.tsx';
import { useStageFocus } from './scan-stage-focus.ts';
import { useRemembered } from './scan-stage-memory.ts';
import { useStagePreview } from './scan-stage-model.ts';
import { SourceStatus, StageNotes } from './scan-stage-notes.tsx';
import { RealPassPicker } from './scan-stage-pass.tsx';
import { SampleInputs, useRealPreview } from './scan-stage-samples.tsx';
import type { ScanStageAction } from './scan-stage-types.ts';
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
  /** The org's zone, for dates in the preview. */
  timeZone?: string;
}

export function ScanStage({
  doc,
  display,
  templateId,
  orgId,
  mode,
  screen,
  onScreenChange,
  timeZone = DEFAULT_TIME_ZONE,
  selected,
  onSelect,
  onAction,
  phone,
}: ScanStageProps) {
  const [role, setRole] = useRemembered<ScanRole>(templateId, 'role', 'door');
  const [theme, setTheme] = useRemembered<'light' | 'dark'>(templateId, 'theme', 'light');
  const [device, setDevice] = useRemembered<keyof typeof FRAME_SIZES>(
    templateId,
    'device',
    'phone',
  );
  const [marks, setMarks] = useRemembered(templateId, 'marks', true);
  const [showLocked, setShowLocked] = useRemembered(templateId, 'locked', false);
  const [layout, onLayout] = useFrameLayout();
  const [source, setSource] = useState<'synthetic' | 'real'>('synthetic');
  const [passId, setPassId] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, Json>>({});
  const [tabId, setTabId] = useRemembered<string | null>(templateId, 'tab', null);
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
  } = useStagePreview({
    doc,
    display,
    screen,
    tabId,
    role,
    now,
    overrides,
    source,
    real,
    timeZone,
  });
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
  const { look, failed } = useOrgLook(orgId);
  const outcome = useMemo(
    () =>
      rendered
        ? previewOutcome({
            rendered,
            tab,
            actions,
            role,
            template: {
              name: String(doc.manifest.name ?? 'Template'),
              style: styleOf(doc.passJson),
            },
            passJson: doc.passJson,
            now,
          })
        : null,
    [rendered, tab, actions, role, doc, now],
  );
  const restricted =
    tab.screen === 'ready' ? actions.filter((action) => !roleAtLeast(role, action.minRole)) : [];
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
              { value: 'desk', label: 'Landscape' },
              { value: 'operator', label: 'Operator' },
            ] as const
          }
          value={device}
          onValueChange={setDevice}
        />
        {phone ? null : (
          <>
            <CheckboxField
              label="Edit marks"
              checked={marks}
              onCheckedChange={(on) => setMarks(on === true)}
            />
            <CheckboxField
              label="Locked areas"
              checked={showLocked}
              disabled={!marks}
              onCheckedChange={(on) => setShowLocked(on === true)}
            />
          </>
        )}
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
      <SourceStatus
        usingReal={usingReal}
        wantsReal={source === 'real' && orgId !== null}
        passId={passId}
        realStatus={real.status}
        restricted={!usingReal && synthetic?.previewRestricted === true}
        noOrg={!orgId}
        lookFailed={failed}
      />
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
        {rendered && outcome ? (
          <ScanFrame
            device={device}
            theme={theme}
            label={`Scanner screen, ${tab.label}`}
            onLayout={onLayout}
            overlay={
              marks && !phone ? (
                <ScanOverlay
                  doc={layout?.doc ?? null}
                  scale={layout?.scale ?? 1}
                  rendered={rendered}
                  contentKey={`${tab.id}:${role}:${device}:${theme}:${usingReal}`}
                  showLocked={showLocked}
                  state={{ selected, active: focusId, onSelect, onFocus: setFocusId }}
                />
              ) : null
            }
          >
            <ScanPreviewScreen
              outcome={outcome}
              surface={device === 'operator' ? 'operator' : 'phone'}
              orgName={look.orgName}
              branding={look.branding}
              logoUrl={look.logoUrl}
            />
          </ScanFrame>
        ) : (
          <p className="sp-error" role="alert">
            {invalidDisplay
              ? 'The authored scan screen is invalid. Correct or replace it before previewing.'
              : 'This scan screen cannot be previewed until its invalid fields are corrected.'}
          </p>
        )}
        <StageNotes
          hiddenPanels={phone ? [] : hiddenPanels}
          restricted={restricted}
          onSelect={onSelect}
        />
      </fieldset>
      <StageDiagnostics fit={fit} cuts={cuts} phone={phone} onSelect={onSelect} />
    </section>
  );
}
