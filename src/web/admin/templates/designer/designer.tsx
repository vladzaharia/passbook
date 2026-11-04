import { Link } from '@tanstack/react-router';
import { Redo2, Undo2 } from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { errorMessage } from '../../../lib/errors.ts';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import { useChangeCount } from '../../../lib/motion.ts';
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
import { useTemplateActions } from '../api.ts';
import { mergeAssets, useDesignCheck, useSaveVersion } from './api.ts';
import type { Op } from './apply.ts';
import { DesignerProvider } from './context.tsx';
import { clearDraft, saveDraft } from './drafts.ts';
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
import './designer.css';

export interface DesignerProps {
  templateId: string;
  name: string;
  /** The version the draft starts from. */
  base: { version: string; doc: DesignDoc };
  /** A draft from an earlier visit, shown instead of the base. */
  draft: DesignDoc | null;
  assetBase: (version: string) => string;
}

const _isEditable = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export function Designer({ templateId, name, base, draft, assetBase }: DesignerProps) {
  const phone = useMediaQuery(PHONE);
  const [version, setVersion] = useState(base.version);
  const [state, dispatch] = useReducer(designerReducer, undefined, () =>
    initialState(draft ?? base.doc, base.doc),
  );
  const [restored, setRestored] = useState(draft !== null);
  const [saved, setSaved] = useState<{ version: string; activated: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dirty = isDirty(state);
  const guard = useUnsavedChangesGuard(dirty);
  const select = useMemo(() => validSelection(state), [state]);
  const check = useDesignCheck(templateId, state.doc);
  const save = useSaveVersion(templateId);
  const actions = useTemplateActions(templateId);
  const base_ = assetBase(version);

  const edit = useCallback(
    (op: Op, merge?: string) =>
      dispatch({ type: 'edit', op, at: Date.now(), ...(merge ? { merge } : {}) }),
    [],
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
  useEffect(() => {
    if (!dirty) {
      if (wasDirty.current) clearDraft(templateId);
      wasDirty.current = false;
      return;
    }
    wasDirty.current = true;
    const t = setTimeout(
      () => saveDraft(templateId, { base: version, doc: state.doc, at: Date.now() }),
      800,
    );
    return () => clearTimeout(t);
  }, [dirty, state.doc, templateId, version]);

  function onKeyDown(e: KeyboardEvent) {
    if (phone) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    // Text fields share the designer's history: one undo model, not a browser one per field.
    e.preventDefault();
    dispatch({ type: k === 'y' || e.shiftKey ? 'redo' : 'undo' });
  }

  const issues = check.data?.report.issues ?? [];
  const blocking = issues.filter((i) => i.severity === 'error').length;

  async function saveVersion(): Promise<'saved' | 'refused' | 'failed'> {
    if (blocking > 0 || check.isError) {
      toast.error(
        `Fix the ${blocking || 'listed'} issue${blocking === 1 ? '' : 's'} first.`,
        'Could not save',
      );
      return 'refused';
    }
    try {
      const result = await save.mutateAsync({ doc: state.doc, activate: false });
      const doc: DesignDoc = { ...state.doc, assets: mergeAssets(result.assets, state.doc.assets) };
      dispatch({ type: 'reset', doc });
      clearDraft(templateId);
      setRestored(false);
      if (result.version) setVersion(result.version);
      setSaved({ version: result.version ?? '', activated: result.activated });
      return 'saved';
    } catch (error) {
      toast.error(error, 'Could not save');
      return 'failed';
    }
  }

  async function activate() {
    if (!saved) return;
    try {
      await actions.activate.mutateAsync({ version: saved.version });
      setSaved({ ...saved, activated: true });
      toast.success('Version active');
    } catch (error) {
      toast.error(error, 'Could not activate');
    }
  }

  const api = useMemo(
    () => ({
      state: { ...state, select },
      doc: state.doc,
      edit,
      select: choose,
      focusTarget,
      dispatch,
      assetBase: base_,
    }),
    [state, select, edit, choose, focusTarget, base_],
  );
  const settle = useChangeCount(state.added?.n);

  return (
    <DesignerProvider value={api}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: shortcuts for the whole designer */}
      <div ref={root} data-designer="" onKeyDown={onKeyDown}>
        <PageHeader
          title={`Design ${name}`}
          breadcrumbs={[
            { label: 'Templates', to: '/admin/templates' },
            { label: name, to: `/admin/templates/${templateId}` },
            { label: 'Design' },
          ]}
          actions={
            phone ? undefined : (
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
        {restored && !phone ? (
          <Callout
            className="mb-4"
            tone="info"
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  dispatch({ type: 'reset', doc: state.saved });
                  clearDraft(templateId);
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
        {saved ? (
          <Callout
            className="mb-4"
            tone="success"
            actions={
              saved.activated ? (
                <Button asChild variant="outline" size="sm">
                  <Link to="/admin/templates/$templateId" params={{ templateId }}>
                    Open template
                  </Link>
                </Button>
              ) : (
                <Button
                  size="sm"
                  loading={actions.activate.isPending}
                  onClick={() => void activate()}
                >
                  Activate
                </Button>
              )
            }
          >
            {saved.activated
              ? 'Version saved and active.'
              : 'Version saved. Passes keep the active version until you activate it.'}
          </Callout>
        ) : null}
        <DesignerLayout
          templateId={templateId}
          structure={<Outline />}
          preview={
            <DesignerPreview
              passJson={check.data?.passJson ?? null}
              assets={state.doc.assets}
              assetBase={base_}
              checking={check.checking}
              settle={settle}
            />
          }
          issues={
            <Issues
              issues={issues}
              checking={check.checking}
              failed={check.isError ? errorMessage(check.error) : undefined}
            />
          }
        />
        {phone ? null : (
          <SaveBar
            dirty={dirty}
            saving={save.isPending}
            saveLabel="Save version"
            onSave={saveVersion}
            onDiscard={() => dispatch({ type: 'reset', doc: state.saved })}
          />
        )}
        <UnsavedChangesDialog blocker={guard} />
      </div>
    </DesignerProvider>
  );
}
