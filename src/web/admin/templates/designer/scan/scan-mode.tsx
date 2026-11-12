import { type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import type { ScanDisplay } from '@/shared/contracts/scan-display.ts';
import { PHONE, useMediaQuery } from '../../../../lib/media.ts';
import { useMode } from '../../../../lib/mode.ts';
import { ConfirmDialog, toast } from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import { DesignerLayout } from '../layout.tsx';
import { isRecord } from '../model.ts';
import { scanDisplayOf } from './document.ts';
import { ScanOutline } from './scan-outline.tsx';
import { scanSelectionAction } from './scan-outline-model.ts';
import { focusScanTarget } from './scan-outline-ui.tsx';
import { displayForPreview } from './scan-preview.ts';
import { ScanStage } from './scan-stage.tsx';

type CanvasAction = 'up' | 'down' | 'duplicate' | 'remove';

/** Scan and pass modes share the designer document, edits, selection, undo and save flow. */
export function ScanMode({
  templateId,
  orgId,
  issues,
}: {
  templateId: string;
  orgId: string | null;
  issues: ReactNode;
}) {
  const { doc, state, edit, select, dispatch, readOnly } = useDesigner();
  const mode = useMode();
  const phone = useMediaQuery(PHONE);
  const root = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<ScanDisplay['screen']>('ok');
  const [confirmation, setConfirmation] = useState<{ id: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const display = scanDisplayOf(doc);
  const invalidDisplay =
    display === null && isRecord(doc.manifest.scan) && Object.hasOwn(doc.manifest.scan, 'display');
  const selected = state.select.section === 'scan-display' ? (state.select.key ?? null) : null;
  const onSelect = useCallback(
    (id: string | null) => select({ section: 'scan-display', ...(id ? { key: id } : {}) }),
    [select],
  );
  const onChange = useCallback(
    (next: ScanDisplayDoc, merge?: string) => edit({ op: 'scan-display', display: next }, merge),
    [edit],
  );
  // Selecting an element of the implicit default makes that visible layout editable.
  // Merely opening or switching to this mode does not make a draft.
  const onStageSelect = useCallback(
    (id: string | null) => {
      if (id && !display && !invalidDisplay && !readOnly && !phone)
        onChange(displayForPreview(doc, null));
      onSelect(id);
    },
    [display, doc, invalidDisplay, onChange, onSelect, phone, readOnly],
  );
  const undo = useCallback(() => dispatch({ type: 'undo' }), [dispatch]);
  const canvasAction = useCallback(
    (id: string, action: CanvasAction, confirmed = false) => {
      if (readOnly || phone) return;
      if (invalidDisplay) {
        setAnnouncement('Replace the invalid scan screen before editing the preview.');
        return;
      }
      const current = display ?? displayForPreview(doc, null);
      const result = scanSelectionAction(current, id, action, confirmed);
      if (result.kind === 'confirm') {
        setConfirmation({ id: result.panelId, message: result.message });
      } else if (result.kind === 'blocked') {
        setAnnouncement(result.message);
      } else {
        onChange(result.display);
        onSelect(result.selected);
        setAnnouncement(result.message);
        if (action === 'remove') {
          toast.undo(result.message, undo);
          focusScanTarget(result.selected);
        }
      }
    },
    [display, doc, invalidDisplay, onChange, onSelect, phone, readOnly, undo],
  );
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const source = event.target instanceof HTMLElement ? event.target : null;
    if (!source) return;
    if (event.key === 'Escape' && source.closest('.dz-structure') && selected) {
      const canvas = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>('[data-preview-target]') ?? [],
      ).find((item) => item.dataset.selectionId === selected);
      if (canvas) {
        event.preventDefault();
        canvas.focus();
      }
      return;
    }
    const hit = source.closest<HTMLButtonElement>('button[data-preview-target]');
    const id = hit?.dataset.selectionId;
    if (
      event.key !== 'Enter' ||
      !hit ||
      hit.hasAttribute('data-locked') ||
      !id ||
      phone ||
      readOnly
    )
      return;
    event.preventDefault();
    onStageSelect(id);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const target = root.current?.querySelector<HTMLElement>(
          `[data-target="${CSS.escape(`scan-display:${id}`)}"]`,
        );
        const region = target?.closest('li') ?? target;
        const control = region?.querySelector<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), [role="combobox"]:not([aria-disabled="true"])',
        );
        (control ?? target)?.focus();
      }),
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: canvas and inspector keyboard focus coordination
    <div ref={root} onKeyDown={onKeyDown}>
      <DesignerLayout
        templateId={templateId}
        orgId={orgId ?? undefined}
        readOnly={readOnly}
        structure={
          <ScanOutline
            doc={doc}
            display={display}
            onChange={onChange}
            selected={selected}
            onSelect={onSelect}
            screen={screen}
            invalid={invalidDisplay}
            onUndo={undo}
          />
        }
        preview={
          <ScanStage
            doc={doc}
            display={display}
            templateId={templateId}
            orgId={orgId}
            mode={mode}
            selected={selected}
            onSelect={onStageSelect}
            phone={phone}
            screen={screen}
            onScreenChange={setScreen}
            onAction={canvasAction}
          />
        }
        issues={issues}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title="Remove panel?"
        description={confirmation?.message}
        confirmLabel="Remove panel"
        destructive
        onConfirm={() => {
          if (confirmation) canvasAction(confirmation.id, 'remove', true);
        }}
      />
    </div>
  );
}
