/** One walk over a doc: every text, expression and condition with its JSON path and effective role. */
import type { ScanRole } from '../../types.ts';
import type { ScanChipDoc, ScanCond, ScanDisplayDoc, ScanRowDoc, ScanText } from './schema.ts';
import { ROLE_RANK } from './scope.ts';

export type SlotZone = 'title' | 'text' | 'staff' | 'refused';

export interface TextSlot {
  /** JSON path under `scan.display`, e.g. `panels.0.rows.1.value`. */
  path: string;
  text: ScanText;
  /** The grapheme cap for literal text; null for none. */
  cap: number | null;
  zone: SlotZone;
  role: ScanRole;
  /** `columns` value slots carry their row so the wrap rule can find the cap. */
  columns?: { size: 'big' | 'normal'; items: number };
}
export interface ExprSlot {
  path: string;
  expr: string;
  role: ScanRole;
  kind: 'holder' | 'currency' | 'value' | 'goal' | 'rewards' | 'amount';
}
export interface CondSlot {
  path: string;
  cond: ScanCond;
  role: ScanRole;
}
export interface DocSlots {
  texts: TextSlot[];
  exprs: ExprSlot[];
  conds: CondSlot[];
}

const maxRole = (a: ScanRole, b?: ScanRole): ScanRole => (b && ROLE_RANK[b] > ROLE_RANK[a] ? b : a);

export function walkDoc(doc: ScanDisplayDoc): DocSlots {
  const out: DocSlots = { texts: [], exprs: [], conds: [] };
  const text = (
    path: string,
    value: ScanText | null | undefined,
    cap: number | null,
    role: ScanRole,
    zone: SlotZone = 'text',
    columns?: TextSlot['columns'],
  ) => {
    if (value === null || value === undefined) return;
    out.texts.push({ path, text: value, cap, zone, role, ...(columns ? { columns } : {}) });
  };
  const expr = (
    path: string,
    value: string | undefined,
    role: ScanRole,
    kind: ExprSlot['kind'],
  ) => {
    if (value !== undefined) out.exprs.push({ path, expr: value, role, kind });
  };
  const cond = (path: string, value: ScanCond | undefined, role: ScanRole) => {
    if (value) out.conds.push({ path, cond: value, role });
  };

  const chip = (path: string, item: ScanChipDoc, parent: ScanRole) => {
    const role = maxRole(parent, item.minRole);
    text(`${path}.text`, item.text, 16, role);
    cond(`${path}.when`, item.when, role);
  };

  const row = (path: string, item: ScanRowDoc, parent: ScanRole) => {
    const role = maxRole(parent, item.minRole);
    cond(`${path}.when`, item.when, role);
    switch (item.type) {
      case 'heading':
        text(`${path}.text`, item.text, 24, role);
        text(`${path}.detail`, item.detail, 24, role);
        break;
      case 'field':
        text(`${path}.label`, item.label, 20, role);
        text(`${path}.value`, item.value, 48, role);
        break;
      case 'big':
        text(`${path}.label`, item.label, 20, role);
        text(`${path}.value`, item.value, 12, role);
        text(`${path}.unit`, item.unit, 12, role);
        break;
      case 'columns':
        item.items.forEach((cell, i) => {
          const at = `${path}.items.${i}`;
          const columns = { size: item.size ?? 'normal', items: item.items.length };
          text(`${at}.label`, cell.label, 12, role);
          text(`${at}.value`, cell.value, columns.size === 'big' ? 8 : 16, role, 'text', columns);
        });
        break;
      case 'progress':
        expr(`${path}.value`, item.value, role, 'value');
        if (typeof item.goal === 'string') expr(`${path}.goal`, item.goal, role, 'goal');
        expr(`${path}.rewards`, item.rewards, role, 'rewards');
        text(`${path}.reward`, item.reward, 24, role);
        break;
      case 'money':
        text(`${path}.label`, item.label, 20, role);
        expr(`${path}.amount`, item.amount, role, 'amount');
        expr(`${path}.currency`, item.currency, role, 'currency');
        break;
      case 'image':
        text(`${path}.title`, item.title, 32, role);
        text(`${path}.detail`, item.detail, 40, role);
        break;
      case 'chips':
        for (const [i, c] of item.items.entries()) chip(`${path}.items.${i}`, c, role);
        break;
      case 'list':
        item.items.forEach((entry, i) => {
          const at = `${path}.items.${i}`;
          const itemRole = maxRole(role, entry.minRole);
          text(`${at}.text`, entry.text, 32, itemRole);
          text(`${at}.detail`, entry.detail, 24, itemRole);
          cond(`${at}.when`, entry.when, itemRole);
        });
        break;
      case 'note':
        text(`${path}.text`, item.text, 140, role);
        break;
      default:
        break;
    }
  };

  expr('holder', doc.holder, 'door', 'holder');
  expr('currency', doc.currency, 'door', 'currency');
  const header = (path: string, h: ScanDisplayDoc['header']) => {
    text(`${path}.title`, h.title, null, 'door', 'title');
    text(`${path}.subtitle`, h.subtitle, 60, 'door');
    for (const [i, c] of (h.chips ?? []).entries()) chip(`${path}.chips.${i}`, c, 'door');
  };
  header('header', doc.header);
  (doc.variants ?? []).forEach((variant, i) => {
    cond(`variants.${i}.when`, variant.when, 'door');
    header(`variants.${i}.header`, variant.header);
  });
  (doc.panels ?? []).forEach((panel, i) => {
    const path = `panels.${i}`;
    const role = maxRole('door', panel.minRole);
    cond(`${path}.when`, panel.when, role);
    text(`${path}.title`, panel.title, 24, role);
    panel.rows.forEach((item, r) => {
      row(`${path}.rows.${r}`, item, role);
    });
  });
  text('notes.staff', doc.notes?.staff, 140, 'door', 'staff');
  if (doc.notes?.refused) text('notes.refused', doc.notes.refused, 100, 'door', 'refused');
  return out;
}

/** The literal text sources of a `ScanText`, plural forms included. */
export function sourcesOf(value: ScanText): string[] {
  return typeof value === 'string'
    ? [value]
    : [value.one, value.other, value.zero ?? ''].filter(Boolean);
}
