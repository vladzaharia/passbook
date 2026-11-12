import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { oneLineCap } from '@/passkit/template/scan-display/density.ts';
import type { ScanRowDoc, ScanText } from '@/passkit/template/scan-display/schema.ts';
import type { ScanRole } from '@/passkit/types.ts';
import { Button, SwitchRow } from '../../../../ui/index.ts';
import { isRecord } from '../model.ts';
import { ScanConditionField } from './scan-condition-fields.tsx';
import { editorKey, useEditorKeys } from './scan-field-keys.ts';
import {
  effectiveScanRole,
  type Manifest,
  type Pass,
  ScanIconField,
  ScanRoleField,
} from './scan-fields.tsx';
import { choices, Pick, type RowProps, TONES } from './scan-row-editor-common.tsx';
import { ScanTextField } from './scan-text-fields.tsx';

type Tone = 'neutral' | 'teal' | 'violet' | 'gold';
type ItemRow = Extract<ScanRowDoc, { type: 'columns' | 'chips' | 'list' }>;

/** Item IDs are stable within the row; the outline reconciles new IDs against the whole document. */
function nextItemId(items: { id: string }[], prefix: 'i' | 'c'): string {
  const ids = new Set(items.map((item) => item.id));
  let n = 1;
  while (ids.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

export function ItemEditor({
  row,
  manifest,
  passJson,
  role,
  onChange,
}: {
  row: ItemRow;
  manifest: Manifest;
  passJson?: Pass;
  role: ScanRole;
  onChange: RowProps['onChange'];
}) {
  const items = Array.isArray(row.items) ? row.items : [];
  const {
    keys: itemKeys,
    items: keyedItems,
    remember: rememberItems,
  } = useEditorKeys<unknown>(items);
  const ids = items.filter((item) => isRecord(item) && typeof item.id === 'string') as {
    id: string;
  }[];
  const idCounts = new Map<string, number>();
  for (const item of ids) idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1);
  const set = (patch: Record<string, unknown>, merge?: string) =>
    onChange({ ...row, ...patch } as ScanRowDoc, merge);
  const setItems = (next: unknown[], nextKeys: string[], merge?: string) => {
    rememberItems(next, nextKeys);
    set({ items: next }, merge);
  };
  const update = (index: number, patch: Record<string, unknown>, merge?: string) =>
    setItems(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      itemKeys,
      merge,
    );
  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const entry = next[index];
    const other = next[to];
    if (!entry || !other) return;
    const nextKeys = [...itemKeys];
    const entryKey = nextKeys[index];
    const otherKey = nextKeys[to];
    if (entryKey === undefined || otherKey === undefined) return;
    next[index] = other;
    next[to] = entry;
    nextKeys[index] = otherKey;
    nextKeys[to] = entryKey;
    setItems(next, nextKeys);
  };
  const add = () => {
    const item =
      row.type === 'columns'
        ? { id: nextItemId(ids, 'i'), label: '', value: '' }
        : row.type === 'chips'
          ? { id: nextItemId(ids, 'c'), text: '', tone: 'neutral' }
          : { id: nextItemId(ids, 'i'), text: '', icon: 'info' };
    setItems([...items, item], [...itemKeys, editorKey()]);
  };
  const min = row.type === 'columns' ? 2 : 1;
  return (
    <>
      {row.type === 'columns' ? (
        <Pick
          label="Column size"
          value={row.size ?? 'normal'}
          options={choices(['normal', 'big'])}
          onChange={(size) => set({ size: size === 'normal' ? undefined : size })}
        />
      ) : null}
      {row.type === 'list' ? (
        <SwitchRow
          label="Pair items on one line"
          checked={row.pair ?? false}
          onCheckedChange={(pair) => set({ pair: pair || undefined })}
        />
      ) : null}
      <div className="grid gap-3">
        {keyedItems.map(({ value: item, key }, index) => {
          if (!isRecord(item))
            return (
              <p key={`fallback:${key}`} className="text-sm text-fg-muted">
                Incomplete item preserved.
              </p>
            );
          const itemId = typeof item.id === 'string' ? item.id : `item_${index + 1}`;
          const itemKey =
            typeof item.id === 'string' && idCounts.get(item.id) === 1
              ? `id:${item.id}`
              : `fallback:${key}`;
          const itemRole = effectiveScanRole(
            role,
            item.minRole === 'door' || item.minRole === 'desk' || item.minRole === 'manager'
              ? item.minRole
              : undefined,
          );
          const text = (label: string, key: string, value: unknown, optional = false) => (
            <ScanTextField
              key={key}
              label={label}
              value={
                typeof value === 'string' || isRecord(value)
                  ? (value as unknown as ScanText)
                  : undefined
              }
              manifest={manifest}
              passJson={passJson}
              audienceRole={itemRole}
              optional={optional}
              mergeKey={`scan:${row.id}:${itemId}:${key}`}
              onChange={(v, merge) => update(index, { [key]: v }, merge)}
            />
          );
          return (
            <div
              key={itemKey}
              tabIndex={-1}
              data-target={`scan-display:${itemId}`}
              className="grid gap-3 rounded-md border border-border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-fg-strong">
                  {row.type === 'columns' ? 'Column' : row.type === 'chips' ? 'Chip' : 'Item'}{' '}
                  {index + 1}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move item ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move item ${index + 1} down`}
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove item ${index + 1}`}
                    disabled={items.length <= min}
                    onClick={() =>
                      setItems(
                        items.filter((_, i) => i !== index),
                        itemKeys.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </div>
              {row.type === 'columns' ? (
                <>
                  {text('Column label', 'label', item.label)}
                  {text('Column value', 'value', item.value)}
                  <p className="text-xs text-fg-muted">
                    About {oneLineCap(row.size === 'big' ? 'big' : 'normal', items.length)}{' '}
                    characters fit on one line.
                  </p>
                </>
              ) : (
                <>
                  {text(row.type === 'chips' ? 'Chip text' : 'Item text', 'text', item.text)}
                  {row.type === 'list' ? text('Item detail', 'detail', item.detail, true) : null}
                  {row.type === 'chips' ? (
                    <Pick
                      label="Chip tone"
                      value={typeof item.tone === 'string' ? item.tone : 'neutral'}
                      options={TONES}
                      onChange={(tone) => update(index, { tone: tone as Tone })}
                    />
                  ) : null}
                  <ScanIconField
                    label="Item icon"
                    required={row.type === 'list'}
                    value={
                      typeof item.icon === 'string'
                        ? (item.icon as Parameters<typeof ScanIconField>[0]['value'])
                        : undefined
                    }
                    onChange={(icon) => update(index, { icon })}
                  />
                  <ScanRoleField
                    label="Who sees this item"
                    value={
                      item.minRole === 'door' ||
                      item.minRole === 'desk' ||
                      item.minRole === 'manager'
                        ? item.minRole
                        : undefined
                    }
                    onChange={(minRole) => update(index, { minRole })}
                  />
                  <ScanConditionField
                    label="Show this item when"
                    value={
                      isRecord(item.when)
                        ? (item.when as unknown as Parameters<
                            typeof ScanConditionField
                          >[0]['value'])
                        : undefined
                    }
                    manifest={manifest}
                    passJson={passJson}
                    audienceRole={itemRole}
                    mergeKey={`scan:${row.id}:${itemId}:when`}
                    onChange={(when, merge) => update(index, { when }, merge)}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="justify-self-start"
        disabled={items.length >= 4}
        iconStart={<Plus aria-hidden />}
        onClick={add}
      >
        Add {row.type === 'columns' ? 'column' : row.type === 'chips' ? 'chip' : 'item'}
      </Button>
    </>
  );
}
