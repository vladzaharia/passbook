import { Redo2, Undo2 } from 'lucide-react';
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
  IconButton,
  PageHeader,
  SaveBar,
  SegmentedControl,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../../ui/index.ts';
import type { Template } from '../versions.ts';
import { useDesignCheck } from './api.ts';
import type { Op } from './apply.ts';
import { DesignerProvider } from './context.tsx';
import { clearDraft } from './drafts.ts';
import { Issues } from './issues.tsx';
import { DesignerLayout } from './layout.tsx';
import { type DesignDoc, findField, type Selection } from './model.ts';
import { Outline } from './outline.tsx';
import { DesignerPreview } from './preview.tsx';
import {
  canRedo,
  canUndo,
  designerReducer,
  initialState,
  isDirty,
  validSelection,
} from './reducer.ts';
import { useSaveFlow } from './save-flow.ts';
import { SavedCallout } from './saved-callout.tsx';
import { ScanMode } from './scan/scan-mode.tsx';
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
  canPublish: boolean;
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
}

export function Designer({
  template,
  canPublish,
  selectedOrg,
  draftKey,
  base,
  draft,
  assetBase,
  readOnly,
  prompt,
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
  const guard = useUnsavedChangesGuard(dirty);
  const select = useMemo(() => validSelection(state), [state]);
  const check = useDesignCheck(templateId, state.doc, !readOnly);
  const base_ = assetBase(version);

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
    const at = findField(state.doc.passJson, added.key);
    if (at) focusTarget({ section: at.group, key: added.key });
  }, [added, state.doc.passJson, focusTarget]);

  useDraftPersistence(draftKey, version, state.doc, dirty);

  function onKeyDown(e: KeyboardEvent) {
    if (phone || readOnly) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    // Text fields share the designer's history: one undo model, not a browser one per field.
    e.preventDefault();
    dispatch({ type: k === 'y' || e.shiftKey ? 'redo' : 'undo' });
  }

  const { issues, blocking } = useDesignerIssues(state.doc, readOnly, check.data?.report.issues);
  const flow = useSaveFlow({
    templateId,
    draftKey,
    latest,
    savedDoc: state.saved,
    draftBase: version,
    blocked: () =>
      check.isError || check.checking || check.isPlaceholderData || !check.data?.report.ok
        ? null
        : blocking,
    dispatch,
    onSaved: (v) => {
      setVersion(v);
      setRestored(false);
    },
  });

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
    }),
    [state, select, edit, choose, focusTarget, base_, readOnly],
  );

  return (
    <DesignerProvider value={api}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: shortcuts for the whole designer */}
      <div ref={root} data-designer="" onKeyDown={onKeyDown}>
        <PageHeader
          title={name}
          breadcrumbs={[
            { label: 'Templates', to: '/admin/templates', search: { orgId: selectedOrg } },
            { label: name, to: `/admin/templates/${templateId}`, search: { orgId: selectedOrg } },
            { label: 'Design' },
          ]}
          actions={
            phone || readOnly ? undefined : (
              <>
                <IconButton
                  label="Undo"
                  icon={<Undo2 aria-hidden />}
                  variant="outline"
                  disabled={!canUndo(state)}
                  onClick={() => dispatch({ type: 'undo' })}
                />
                <IconButton
                  label="Redo"
                  icon={<Redo2 aria-hidden />}
                  variant="outline"
                  disabled={!canRedo(state)}
                  onClick={() => dispatch({ type: 'redo' })}
                />
              </>
            )
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
        {flow.saved ? <SavedCallout templateId={templateId} canPublish={canPublish} /> : null}
        {mode === 'scan' ? (
          <ScanMode
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
              <DesignerPreview
                passJson={readOnly ? readOnly.passJson : (check.lastBuilt ?? null)}
                assets={state.doc.assets}
                assetBase={base_}
                checking={readOnly ? false : check.checking}
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
            dirty={dirty}
            saving={flow.saving}
            saveLabel="Save version"
            onSave={() => flow.run(state.doc)}
            onDiscard={() => {
              dispatch({ type: 'reset', doc: state.saved });
              clearDraft(draftKey);
              setRestored(false);
            }}
          />
        )}
        <UnsavedChangesDialog blocker={guard} />
      </div>
    </DesignerProvider>
  );
}
