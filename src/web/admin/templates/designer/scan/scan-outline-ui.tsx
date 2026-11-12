import { ArrowDown, ArrowUp, ChevronRight, Copy, Trash2 } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId } from 'react';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { IconButton, toast } from '../../../../ui/index.ts';
import type { DesignDoc } from '../model.ts';
import { type ScanSelectionAction, scanSelectionAction } from './scan-outline-model.ts';

export type Editor = {
  doc: DesignDoc;
  bindings: DesignDoc;
  display: ScanDisplayDoc;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (display: ScanDisplayDoc, merge?: string) => void;
  onUndo?: () => void;
  screen: 'ready' | 'ok' | 'heads_up' | 'refused';
  say: (message: string) => void;
};

export { applySelection, focusScanTarget, Keys, nudgeKey, OutlineSection, undoToast };

/** After a removal the invoking control is gone: focus what is selected now, or the panel list. */
function focusScanTarget(id: string | null) {
  const find = (key: string) =>
    document.querySelector<HTMLElement>(`[data-target="${CSS.escape(`scan-display:${key}`)}"]`);
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      (find(id ?? 'panels') ?? find('panels') ?? find('header'))?.focus(),
    ),
  );
}

function undoToast(editor: Editor, message = 'Removed') {
  if (editor.onUndo) toast.undo(message, editor.onUndo);
}
function applySelection(
  editor: Editor,
  id: string,
  action: ScanSelectionAction,
  confirmed = false,
) {
  const result = scanSelectionAction(editor.display, id, action, confirmed);
  editor.say(result.message);
  if (result.kind !== 'change') return;
  editor.onChange(result.display);
  editor.onSelect(result.selected);
  if (action === 'remove') {
    undoToast(editor, result.message);
    focusScanTarget(result.selected);
  }
}

function OutlineSection({
  title,
  id,
  open,
  onClick,
  children,
  count,
}: {
  title: string;
  id: string;
  open: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: ReactNode;
}) {
  const region = useId();
  return (
    <li className="dz-section" data-open={open || undefined}>
      <h2>
        <button
          type="button"
          className="dz-head"
          data-target={`scan-display:${id}`}
          aria-expanded={open}
          aria-controls={region}
          onClick={onClick}
        >
          <ChevronRight aria-hidden className="dz-chevron size-4 shrink-0" />
          <span className="min-w-0 flex-1 text-left">{title}</span>
          {count}
        </button>
      </h2>
      {open ? (
        <section id={region} aria-label={title} className="dz-panel grid gap-4">
          {children}
        </section>
      ) : null}
    </li>
  );
}
function Keys({
  name,
  index,
  length,
  onMove,
  onDuplicate,
  onRemove,
  disabledDuplicate,
  disabledRemove,
  upReason,
  downReason,
}: {
  name: string;
  index: number;
  length: number;
  onMove: (delta: -1 | 1) => void;
  onDuplicate?: () => void;
  onRemove: () => void;
  disabledDuplicate?: string | undefined;
  disabledRemove?: string | undefined;
  upReason?: string | undefined;
  downReason?: string | undefined;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        label={`Move ${name} up${upReason ? `: ${upReason}` : ''}`}
        icon={<ArrowUp aria-hidden />}
        size="sm"
        disabled={index === 0 || !!upReason}
        onClick={() => onMove(-1)}
      />
      <IconButton
        label={`Move ${name} down${downReason ? `: ${downReason}` : ''}`}
        icon={<ArrowDown aria-hidden />}
        size="sm"
        disabled={index === length - 1 || !!downReason}
        onClick={() => onMove(1)}
      />
      {onDuplicate ? (
        <IconButton
          label={`Duplicate ${name}${disabledDuplicate ? `: ${disabledDuplicate}` : ''}`}
          icon={<Copy aria-hidden />}
          size="sm"
          disabled={!!disabledDuplicate}
          onClick={onDuplicate}
        />
      ) : null}
      <IconButton
        label={`Remove ${name}${disabledRemove ? `: ${disabledRemove}` : ''}`}
        icon={<Trash2 aria-hidden />}
        size="sm"
        disabled={!!disabledRemove}
        onClick={onRemove}
      />
    </div>
  );
}
function nudgeKey(event: KeyboardEvent, move: (delta: -1 | 1) => void) {
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    move(event.key === 'ArrowUp' ? -1 : 1);
  }
}
