import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { type DragEvent, type KeyboardEvent, useState } from 'react';
import { LIMITS } from '@/passkit/schema/validate-fields.ts';
import { cn } from '../../../lib/cn.ts';
import { removeWithTransition } from '../../../lib/motion.ts';
import { Button, IconButton } from '../../../ui/index.ts';
import { fieldSource } from './bindings.ts';
import { useDesigner } from './context.tsx';
import { FieldEditor } from './field-editor.tsx';
import { fieldsOf, GROUP_LABEL, type GroupId, keyOf, styleOf } from './model.ts';

const DRAG_TYPE = 'application/x-designer-field';

/** One group's fields: pick one to edit, drag or use Alt+Arrow keys (or the buttons) to reorder. */
export function FieldsSection({ group }: { group: GroupId }) {
  const { doc, edit, state, select } = useDesigner();
  const fields = fieldsOf(doc.passJson, group);
  const max = (LIMITS[styleOf(doc.passJson)] as Partial<Record<string, number>>)[group];
  const full = max !== undefined && fields.length >= max;
  const [note, setNote] = useState('');
  const [over, setOver] = useState<number | null>(null);
  // Only the grip starts a drag, so text inside an open editor stays selectable.
  const [armed, setArmed] = useState<string | null>(null);
  const open = state.select.section === group ? state.select.key : undefined;
  const added = state.added?.kind === 'field' ? state.added : null;

  function nudge(key: string, delta: -1 | 1) {
    const at = fields.findIndex((f) => keyOf(f) === key);
    const to = at + delta;
    if (to < 0 || to >= fields.length) return;
    edit({ op: 'field-nudge', key, delta });
    setNote(`${keyOf(fields[at] ?? {})} moved to position ${to + 1} of ${fields.length}.`);
  }
  function onKey(e: KeyboardEvent, key: string) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    nudge(key, e.key === 'ArrowUp' ? -1 : 1);
  }
  function drop(e: DragEvent, index: number) {
    e.preventDefault();
    setOver(null);
    setArmed(null);
    const key = e.dataTransfer.getData(DRAG_TYPE);
    if (key) edit({ op: 'field-move', key, group, index });
  }
  return (
    <div className="grid gap-3">
      <ul
        aria-label={`${GROUP_LABEL[group]} fields`}
        className="grid gap-1.5"
        // Dropping on the list's empty space appends.
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => drop(e, fields.length)}
      >
        {fields.map((field, i) => {
          const key = keyOf(field);
          const bound = fieldSource(doc.manifest, key).kind !== 'static';
          return (
            <li
              key={key}
              data-row-id={`field:${key}`}
              className="dz-row"
              data-new={added?.key === key ? added.n : undefined}
              data-open={open === key || undefined}
              data-over={over === i || undefined}
              draggable={armed === key}
              onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, key)}
              onDragEnd={() => setArmed(null)}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOver(i);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.stopPropagation();
                drop(e, i);
              }}
            >
              <div className="flex items-center gap-1">
                <span
                  className="dz-grip grid shrink-0 cursor-grab place-items-center"
                  onPointerDown={() => setArmed(key)}
                  onPointerUp={() => setArmed(null)}
                >
                  <GripVertical aria-hidden className="size-4 text-fg-muted" />
                </span>
                <button
                  type="button"
                  className="dz-pick"
                  data-target={`${group}:${key}`}
                  aria-expanded={open === key}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => select({ section: group, key: open === key ? undefined : key })}
                  onKeyDown={(e) => onKey(e, key)}
                >
                  <span className="truncate font-medium text-fg-strong">
                    {String(field.label ?? '') || key}
                  </span>
                  <span className="truncate text-xs text-fg-muted">
                    {bound ? 'from input' : String(field.value ?? '')}
                  </span>
                </button>
                <IconButton
                  label={`Move ${key} up`}
                  icon={<ArrowUp aria-hidden />}
                  variant="ghost"
                  size="sm"
                  disabled={i === 0}
                  onClick={() => nudge(key, -1)}
                />
                <IconButton
                  label={`Move ${key} down`}
                  icon={<ArrowDown aria-hidden />}
                  variant="ghost"
                  size="sm"
                  disabled={i === fields.length - 1}
                  onClick={() => nudge(key, 1)}
                />
                <IconButton
                  label={`Remove ${key}`}
                  icon={<Trash2 aria-hidden />}
                  variant="ghost"
                  size="sm"
                  onClick={() => removeWithTransition(() => edit({ op: 'field-remove', key }))}
                />
              </div>
              {open === key ? <FieldEditor field={field} group={group} /> : null}
            </li>
          );
        })}
      </ul>
      {fields.length === 0 ? <p className={cn('text-sm text-fg-muted')}>No fields here.</p> : null}
      <p role="status" aria-live="polite" className="sr-only">
        {note}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={full}
          iconStart={<Plus aria-hidden />}
          onClick={() => edit({ op: 'field-add', group })}
        >
          Add field
        </Button>
        {full ? (
          <span className="text-xs text-fg-muted">
            {GROUP_LABEL[group]} holds {max} {max === 1 ? 'field' : 'fields'}.
          </span>
        ) : null}
      </div>
    </div>
  );
}
