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
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../../ui/index.ts';
import { ActivateDialog } from '../activate-dialog.tsx';
import type { Template } from '../versions.ts';
import { useDesignCheck } from './api.ts';
import type { Op } from './apply.ts';
import { DesignerProvider } from './context.tsx';
import { clearDraft, saveDraft } from './drafts.ts';
import { Issues } from './issues.tsx';
import { DesignerLayout } from './layout.tsx';
import { localIssues } from './local-issues.ts';
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
import './designer.css';

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
  const [restored, setRestored] = useState(draft !== null);
  const [activating, setActivating] = useState<string | null>(null);
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
  const focusTarget = useCallback((s: Selection) => {
    dispatch({ type: 'select', select: s });
    const id = s.key ? `${s.section}:${s.key}` : s.section;
    // The section opens on the next render; focus what the issue names once it exists.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        root.current?.querySelector<HTMLElement>(`[data-target="${CSS.escape(id)}"]`)?.focus(),
      ),
    );
  }, []);

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

  // The draft survives a reload; saving or discarding clears it.
  // A draft from an older version is offered by the page; it is only cleared once edits were made here.
  const wasDirty = useRef(false);
  const warned = useRef(false);
  useEffect(() => {
    if (!dirty) {
      if (wasDirty.current) clearDraft(draftKey);
      wasDirty.current = false;
      return;
    }
    wasDirty.current = true;
    const t = setTimeout(() => {
      const kept = saveDraft(draftKey, { base: version, doc: state.doc, at: Date.now() });
      if (!kept && !warned.current) {
        warned.current = true;
        toast.info('This draft is too big to keep. Save a version to keep your work.');
      }
    }, 800);
    return () => clearTimeout(t);
  }, [dirty, state.doc, draftKey, version]);

  function onKeyDown(e: KeyboardEvent) {
    if (phone || readOnly) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    // Text fields share the designer's history: one undo model, not a browser one per field.
    e.preventDefault();
    dispatch({ type: k === 'y' || e.shiftKey ? 'redo' : 'undo' });
  }

  const issues = useMemo(
    () =>
      readOnly
        ? readOnly.issues
        : [...localIssues(state.doc), ...(check.data?.report.issues ?? [])],
    [readOnly, state.doc, check.data],
  );
  const blocking = issues.filter((i) => i.severity === 'error').length;
  const flow = useSaveFlow({
    templateId,
    draftKey,
    latest,
    blocked: () => (check.isError ? null : blocking),
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
            { label: 'Templates', to: '/admin/templates' },
            { label: name, to: `/admin/templates/${templateId}` },
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
        {flow.saved ? (
          <SavedCallout
            templateId={templateId}
            saved={flow.saved}
            onActivate={() => setActivating(flow.saved?.version ?? null)}
          />
        ) : null}
        <DesignerLayout
          templateId={templateId}
          readOnly={Boolean(readOnly)}
          structure={<Outline />}
          preview={
            <DesignerPreview
              passJson={readOnly ? readOnly.passJson : (check.data?.passJson ?? null)}
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
        {phone || readOnly ? null : (
          <SaveBar
            dirty={dirty}
            saving={flow.saving}
            saveLabel="Save version"
            onSave={() => flow.run(state.doc)}
            onDiscard={() => dispatch({ type: 'reset', doc: state.saved })}
          />
        )}
        <ActivateDialog
          template={template}
          version={activating}
          onClose={() => setActivating(null)}
          onActivated={() => flow.setSaved((s) => (s ? { ...s, activated: true } : s))}
        />
        <UnsavedChangesDialog blocker={guard} />
      </div>
    </DesignerProvider>
  );
}
