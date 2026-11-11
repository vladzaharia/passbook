import type {
  ScanDisplayDoc,
  ScanPanelDoc,
  ScanRowDoc,
} from '@/passkit/template/scan-display/schema.ts';

type RowType = ScanRowDoc['type'];
type Prefix = 'p_' | 'r_' | 'i_' | 'c_' | 'v_';

export { allIds, copyPanel, copyRow, freshRow, nextId, reconcileRow, rowIds };

/** Ids are document-wide, including the items inside group rows. */
function rowIds(row: ScanRowDoc): string[] {
  return [
    row.id,
    ...(row.type === 'columns' || row.type === 'chips' || row.type === 'list'
      ? row.items.map((item) => item.id)
      : []),
  ];
}
function allIds(doc: ScanDisplayDoc): Set<string> {
  return new Set([
    ...(doc.header.chips ?? []).map((chip) => chip.id),
    ...(doc.variants ?? []).flatMap((variant) => [
      variant.id,
      ...(variant.header.chips ?? []).map((chip) => chip.id),
    ]),
    ...(doc.panels ?? []).flatMap((panel) => [panel.id, ...panel.rows.flatMap(rowIds)]),
  ]);
}
function nextId(used: Set<string>, prefix: Prefix): string {
  let n = 1;
  let id = `${prefix}${n.toString(36).padStart(4, '0')}`;
  while (used.has(id)) id = `${prefix}${(++n).toString(36).padStart(4, '0')}`;
  used.add(id);
  return id;
}
/** Keep preset item names where possible so their slot mappings survive an upgrade. */
function copyItemId(used: Set<string>, original: string, prefix: 'i_' | 'c_'): string {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(original)) return nextId(used, prefix);
  if (!used.has(original)) {
    used.add(original);
    return original;
  }
  const base = original.slice(0, 19);
  let n = 1;
  let candidate = `${base}_${n.toString(36)}`;
  while (used.has(candidate)) candidate = `${base}_${(++n).toString(36)}`;
  if (candidate.length > 24) return nextId(used, prefix);
  used.add(candidate);
  return candidate;
}
function copyRow(row: ScanRowDoc, used: Set<string>): ScanRowDoc {
  const id = nextId(used, 'r_');
  if (row.type === 'columns' || row.type === 'list')
    return {
      ...row,
      id,
      items: row.items.map((item) => ({ ...item, id: copyItemId(used, item.id, 'i_') })),
    } as ScanRowDoc;
  if (row.type === 'chips')
    return {
      ...row,
      id,
      items: row.items.map((item) => ({ ...item, id: copyItemId(used, item.id, 'c_') })),
    };
  return { ...row, id };
}
function copyPanel(panel: ScanPanelDoc, used: Set<string>): ScanPanelDoc {
  return { ...panel, id: nextId(used, 'p_'), rows: panel.rows.map((row) => copyRow(row, used)) };
}

/** Keep old item ids and repair only collisions from newly inserted items. */
function reconcileRow(doc: ScanDisplayDoc, previous: ScanRowDoc, row: ScanRowDoc): ScanRowDoc {
  if (row.type !== 'columns' && row.type !== 'chips' && row.type !== 'list') return row;
  const previousIds = new Set(rowIds(previous).slice(1));
  const used = allIds(doc);
  const seen = new Set<string>();
  const items = row.items.map((item) => {
    const keep = previousIds.has(item.id) && !seen.has(item.id);
    const id =
      keep || (!used.has(item.id) && !seen.has(item.id))
        ? item.id
        : nextId(used, row.type === 'chips' ? 'c_' : 'i_');
    used.add(id);
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
  return { ...row, items } as ScanRowDoc;
}
function freshRow(type: RowType, used: Set<string>): ScanRowDoc {
  const id = nextId(used, 'r_');
  switch (type) {
    case 'heading':
      return { id, type, text: '' };
    case 'field':
      return { id, type, label: 'Field', value: '' };
    case 'big':
      return { id, type, value: '' };
    case 'columns':
      return {
        id,
        type,
        items: [
          { id: nextId(used, 'i_'), label: '', value: '' },
          { id: nextId(used, 'i_'), label: '', value: '' },
        ],
      };
    case 'progress':
      return { id, type, value: '0', goal: 10, style: 'bar' };
    case 'money':
      return { id, type, amount: '0' };
    case 'history':
      return { id, type, source: 'visits', limit: 2, show: ['when'] };
    case 'image':
      return { id, type, source: 'thumbnail' };
    case 'chips':
      return { id, type, items: [{ id: nextId(used, 'c_'), text: '', tone: 'neutral' }] };
    case 'list':
      return { id, type, items: [{ id: nextId(used, 'i_'), icon: 'star', text: '' }] };
    case 'note':
      return { id, type, text: '' };
    case 'divider':
      return { id, type };
  }
}
