/** Save-time rules for `display.customer` (ST 3.2). Errors only: the block shows people the doc names. */
import type { ValidationIssue } from '../../types.ts';
import { condPaths } from './condition.ts';
import { panelUnits } from './density.ts';
import type { ScanChipDoc, ScanDisplayDoc, ScanRowDoc } from './schema.ts';
import { splitPath } from './text.ts';
import { issueOf } from './validate-rules.ts';
import { sourcesOf, walkDoc } from './walk.ts';

export const CUSTOMER_PANEL_UNITS = 4;
export const CUSTOMER_ROWS = new Set([
  'heading',
  'field',
  'big',
  'columns',
  'progress',
  'money',
  'chips',
  'list',
  'divider',
  'history',
]);
const HIDDEN_EVENT = new Set(['arrived', 'expected', 'capacity']);

/** Whether a customer may never read a binding path (inputs, the scanner, counts, the external id). */
export function bannedForCustomer(path: string): boolean {
  const split = splitPath(path.trim());
  if (!split) return false;
  if (split.root === 'inputs' || split.root === 'scanner' || split.root === 'occupancy')
    return true;
  if (split.root === 'event') return HIDDEN_EVENT.has(split.rest[0] ?? '');
  if (split.root === 'pass') return split.rest[0] === 'externalId';
  // A door and a plan's hours say where the member may go: the customer screen is in the room.
  if (split.root === 'access') return split.rest[0] === 'zone' || split.rest[0] === 'hours';
  return false;
}

/** A row type or its history source the customer view may not render. */
export function rowAllowed(row: ScanRowDoc): boolean {
  if (!CUSTOMER_ROWS.has(row.type)) return false;
  if (row.type !== 'history') return true;
  return (
    row.source !== 'scans' &&
    row.input === undefined &&
    (row.show ?? []).every((s) => s === 'when' || s === 'amount')
  );
}

/** The first panel whose preset is loyalty or balance, the default when no `customer` block is set. */
export function defaultCustomerPanel(doc: ScanDisplayDoc): string | null {
  const panel = (doc.panels ?? []).find((p) => ['loyalty', 'balance'].includes(p.preset?.id ?? ''));
  return panel?.id ?? null;
}

interface NamedChip {
  chip: ScanChipDoc;
  path: string;
  header: string;
}

function chipsOf(doc: ScanDisplayDoc): NamedChip[] {
  const out: NamedChip[] = [];
  const add = (header: string, chips: ScanChipDoc[] | undefined) => {
    for (const [i, chip] of (chips ?? []).entries())
      out.push({ chip, path: `${header}.chips.${i}`, header });
  };
  add('header', doc.header.chips);
  for (const [v, variant] of (doc.variants ?? []).entries())
    add(`variants.${v}.header`, variant.header.chips);
  return out;
}

export function customerIssues(doc: ScanDisplayDoc): ValidationIssue[] {
  const block = doc.customer;
  if (!block) return [];
  const issues: ValidationIssue[] = [];
  const push = (code: string, path: string, message: string) =>
    issues.push(issueOf('error', `CUSTOMER_${code}`, path, message));
  const prefixes: string[] = [];
  const perHeader = new Map<string, number>();
  const all = chipsOf(doc);
  for (const id of block.chips ?? []) {
    const found = all.filter((c) => c.chip.id === id);
    if (found.length === 0) push('REF', 'customer.chips', `There is no chip "${id}".`);
    for (const { chip, path, header } of found) {
      prefixes.push(`${path}.`);
      perHeader.set(header, (perHeader.get(header) ?? 0) + 1);
      if (chip.minRole) push('ROLE', path, 'A customer chip cannot be raised to a role.');
    }
  }
  for (const [header, n] of perHeader)
    if (n > 2) push('DENSITY', header, 'Show at most 2 chips to the customer per header.');
  if (block.panel) {
    const at = (doc.panels ?? []).findIndex((p) => p.id === block.panel);
    const panel = doc.panels?.[at];
    if (!panel) push('REF', 'customer.panel', `There is no panel "${block.panel}".`);
    else {
      const path = `panels.${at}`;
      prefixes.push(`${path}.`);
      if (panel.minRole) push('ROLE', path, 'A customer panel cannot be raised to a role.');
      for (const [r, row] of panel.rows.entries()) {
        if (!rowAllowed(row))
          push('ROW', `${path}.rows.${r}`, `A customer panel cannot show ${row.type}.`);
        if (row.minRole)
          push('ROLE', `${path}.rows.${r}`, 'A customer row cannot be raised to a role.');
        if ('items' in row && row.items.some((i) => 'minRole' in i && i.minRole))
          push('ROLE', `${path}.rows.${r}`, 'A customer item cannot be raised to a role.');
      }
      if (panelUnits(panel) > CUSTOMER_PANEL_UNITS)
        push('DENSITY', path, `A customer panel holds ${CUSTOMER_PANEL_UNITS} units at most.`);
    }
  }
  if (prefixes.length === 0) return issues;
  const named = (path: string) => prefixes.some((p) => path.startsWith(p));
  const slots = walkDoc(doc);
  const bad = (path: string, binding: string) => {
    if (bannedForCustomer(binding))
      push('SCOPE', path, `The customer cannot read "${binding}". Choose another field.`);
  };
  for (const slot of slots.texts.filter((s) => named(s.path)))
    for (const source of sourcesOf(slot.text)) {
      for (const part of source.matchAll(/\{\{([^}|]*)/g)) bad(slot.path, part[1] ?? '');
      if (typeof slot.text !== 'string') bad(slot.path, slot.text.count.split('|')[0] ?? '');
    }
  for (const slot of slots.exprs.filter((s) => named(s.path)))
    bad(slot.path, slot.expr.split('|')[0] ?? '');
  for (const slot of slots.conds.filter((s) => named(s.path)))
    for (const path of condPaths(slot.cond)) bad(slot.path, path);
  return issues;
}
