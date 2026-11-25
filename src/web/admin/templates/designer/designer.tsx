import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ValidationIssue } from '@/passkit/types.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import {
  Button,
  Callout,
  SaveBar,
  SegmentedControl,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../../ui/index.ts';
import { type Template, versionNumber } from '../versions.ts';
import { useDesignCheck } from './api.ts';
import type { Op } from './apply.ts';
import { DesignerProvider } from './context.tsx';
import { type CreateDesign, useCreateFlow } from './create-flow.ts';
import { DesignerHeader } from './designer-header.tsx';
import { clearDraft } from './drafts.ts';
import { useGoalFlow } from './goal-flow.tsx';
import { Issues } from './issues.tsx';
import { DesignerLayout } from './layout.tsx';
import { type DesignDoc, findField, previewTargetOf, type Selection } from './model.ts';
import { useOrgBrandedPass } from './org-logo-text.ts';
import { Outline } from './outline.tsx';
import {
  canRedo,
  canUndo,
  designerReducer,
  initialState,
  isDirty,
  validSelection,
} from './reducer.ts';
import { useSaveFlow } from './save-flow.ts';
import { ScanModeSafe } from './scan/scan-mode-safe.tsx';
import { DesignerStage } from './stage.tsx';
import { useStampsPreview } from './stamp-preview.ts';
import { useDesignerIssues } from './use-designer-issues.ts';
import { useDraftPersistence } from './use-draft-persistence.ts';
import './designer.css';

type DesignerMode = 'pass' | 'scan';
const MODES = [
  { value: 'pass', label: 'Pass' },
  { value: 'scan', label: 'Scan screen' },
] as const;

/** A template that cannot be changed: the card and its issues stay, the structure is inert. */
export interface ReadOnlyDesign {
  /** Why it is read only, with the way out. */
  notice: ReactNode;
  /** The built pass to show; the dry run is not available for it. */
  passJson: Record<string, unknown> | null;
  issues: readonly ValidationIssue[];
}

export interface DesignerProps {
  template: Template;
  selectedOrg: string | undefined;
  /** Where drafts of this template are kept (person, organisation, template). */
  draftKey: string;
  /** The version the draft starts from. */
  base: { version: string; doc: DesignDoc };
  /** A draft from an earlier visit, shown instead of the base. */
  draft: DesignDoc | null;
  assetBase: (version: string) => string;
  readOnly?: ReadOnlyDesign;
  /** Shown under the title, before the designer: the stale-draft question. */
  prompt?: ReactNode;
  /** A draft of a blueprint: Create template makes the template; nothing exists before. */
  create?: CreateDesign;
}

export function Designer({
  template,
  selectedOrg,
  draftKey,
  base,
  draft,
  assetBase,
  readOnly,
  prompt,
  create,
}: DesignerProps) {
  const templateId = template.id;
  const name = template.name;
  const phone = useMediaQuery(PHONE);
  const [version, setVersion] = useState(base.version);
  const [state, dispatch] = useReducer(designerReducer, undefined, () =>
    initialState(draft ?? base.doc, base.doc),
  );
  const [mode, setMode] = useState<DesignerMode>('pass');
  const selections = useRef<Record<DesignerMode, Selection>>({
    pass: state.select,
    scan: { section: 'scan-display' },
  });
  selections.current[mode] = state.select;
  const [restored, setRestored] = useState(draft !== null);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(state.doc);
  latest.current = state.doc;
  const dirty = isDirty(state);
  const select = useMemo(() => validSelection(state), [state]);
  const base_ = assetBase(version);
  const stamps = useStampsPreview(state.doc, base_);
  const check = useDesignCheck(
    templateId,
    state.doc,
    !readOnly,
    stamps.checkCount,
    create ? { orgId: create.orgId, name: create.name } : undefined,
  );
  const shownPass = useOrgBrandedPass(check.lastBuilt);

  const edit = useCallback(
    (op: Op, merge?: string) => {
      if (!readOnly) dispatch({ type: 'edit', op, at: Date.now(), ...(merge ? { merge } : {}) });
    },
    [readOnly],
  );
  const choose = useCallback((s: Selection) => dispatch({ type: 'select', select: s }), []);
  const changeMode = useCallback(
    (next: DesignerMode) => {
      if (next === mode) return;
      dispatch({ type: 'select', select: selections.current[next] });
      setMode(next);
    },
    [mode],
  );
  const focusTarget = useCallback(
    (s: Selection) => {
      const targetMode = s.section === 'scan-display' ? 'scan' : 'pass';
      if (targetMode !== mode) setMode(targetMode);
      dispatch({ type: 'select', select: s });
      const id = s.key ? `${s.section}:${s.key}` : s.section;
      // The section opens on the next render; focus what the issue names once it exists.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          root.current?.querySelector<HTMLElement>(`[data-target="${CSS.escape(id)}"]`)?.focus(),
        ),
      );
    },
    [mode],
  );

  // A new field opens its editor and takes focus, once per add.
  const handled = useRef(0);
  const added = state.added;
  useEffect(() => {
    if (!added || added.n === handled.current) return;
    handled.current = added.n;
    if (added.kind === 'input') return focusTarget({ section: 'inputs', key: added.key });
    const at = findField(state.doc.passJson, added.key, state.doc.target);
    if (at) focusTarget({ section: at.group, key: added.key });
  }, [added, state.doc.passJson, state.doc.target, focusTarget]);

  useDraftPersistence(draftKey, version, state.doc, dirty);

  function onKeyDown(e: KeyboardEvent) {
    if (phone || readOnly) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    e.preventDefault(); // Text fields share the designer's history: one undo model, not a browser one per field.
    dispatch({ type: k === 'y' || e.shiftKey ? 'redo' : 'undo' });
  }

  const { issues, blocking } = useDesignerIssues(state.doc, readOnly, check.data?.report.issues);
  const blocked = () =>
    check.isError || check.checking || check.isPlaceholderData || !check.data?.report.ok
      ? null
      : blocking;
  const live = useRef({ blocked, checking: check.checking });
  live.current = { blocked, checking: check.checking };
  const created = useCreateFlow(create, blocked);
  // A new template is unsaved until Create template, edits or not.
  const guard = useUnsavedChangesGuard(create ? created.made === null : dirty);
  const flow = useSaveFlow({
    templateId,
    draftKey,
    latest,
    savedDoc: state.saved,
    draftBase: version,
    blocked: () => live.current.blocked(),
    checking: () => live.current.checking,
    dispatch,
    onSaved: (v) => {
      toast.success(`Saved v${versionNumber(template, v) ?? template.versions.length + 1}`);
      setVersion(v);
      setRestored(false);
    },
  });
  const goalFlow = useGoalFlow(templateId, template.passCount, state, edit, flow, check.checking);

  const api = useMemo(
    () => ({
      state: { ...state, select },
      doc: state.doc,
      edit,
      select: choose,
      focusTarget,
      dispatch,
      assetBase: base_,
      readOnly: Boolean(readOnly),
      stamps: stamps.slider,
      orgId: selectedOrg,
    }),
    [state, select, edit, choose, focusTarget, base_, readOnly, stamps.slider, selectedOrg],
  );

  return (
    <DesignerProvider value={api}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: shortcuts for the whole designer */}
      <div ref={root} data-designer="" onKeyDown={onKeyDown}>
        <DesignerHeader
          templateId={templateId}
          name={name}
          orgId={selectedOrg}
          create={create}
          template={template}
          undoRedo={
            phone || readOnly
              ? null
              : { canUndo: canUndo(state), canRedo: canRedo(state), dispatch }
          }
        />
        {readOnly?.notice}
        {prompt}
        <div className="mb-4">
          <SegmentedControl
            label="Designer mode"
            options={MODES}
            value={mode}
            onValueChange={changeMode}
          />
        </div>
        {restored && !phone && !readOnly ? (
          <Callout
            className="mb-4"
            tone="info"
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  dispatch({ type: 'reset', doc: state.saved });
                  clearDraft(draftKey);
                  setRestored(false);
                }}
              >
                Discard draft
              </Button>
            }
          >
            Restored your unsaved draft.
          </Callout>
        ) : null}
        {mode === 'scan' ? (
          <ScanModeSafe
            onBack={() => setMode('pass')}
            templateId={templateId}
            orgId={selectedOrg ?? null}
            issues={
              <Issues
                issues={issues}
                checking={readOnly ? false : check.checking}
                failed={check.isError && !readOnly ? errorMessage(check.error) : undefined}
              />
            }
          />
        ) : (
          <DesignerLayout
            templateId={templateId}
            orgId={selectedOrg}
            readOnly={Boolean(readOnly)}
            structure={<Outline />}
            preview={
              <DesignerStage
                manifest={state.doc.manifest}
                templateId={create ? undefined : templateId}
                orgId={selectedOrg}
                onPaper={
                  readOnly || phone ? undefined : (patch) => edit({ op: 'paper', patch }, 'paper')
                }
                passJson={readOnly ? readOnly.passJson : shownPass}
                target={previewTargetOf(state.doc.passJson, state.doc.target)}
                assets={state.doc.assets}
                assetBase={base_}
                checking={readOnly ? false : check.checking}
                stripUrl={stamps.stripUrl}
              />
            }
            issues={
              <Issues
                issues={issues}
                checking={readOnly ? false : check.checking}
                failed={check.isError && !readOnly ? errorMessage(check.error) : undefined}
              />
            }
          />
        )}
        {phone || readOnly ? null : (
          <SaveBar
            dirty={create ? created.made === null : dirty}
            saving={create ? created.saving : flow.saving}
            saveLabel={create ? 'Create template' : 'Save version'}
            onSave={create ? () => created.run(state.doc) : goalFlow.onSave}
            onDiscard={() => {
              dispatch({ type: 'reset', doc: state.saved });
              clearDraft(draftKey);
              setRestored(false);
            }}
          />
        )}
        {goalFlow.dialog}
        <UnsavedChangesDialog blocker={guard} />
      </div>
    </DesignerProvider>
  );
}
