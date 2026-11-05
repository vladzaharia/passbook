/** Structure rules of `scanDisplayIssues`: placement, references, conditions, density and warnings. */
import { condPaths, condShape } from './condition.ts';
import {
  DENSITY,
  DOC_SCREENS,
  type DocScreen,
  oneLineCap,
  panelsOn,
  panelUnits,
  screenUnits,
} from './density.ts';
import { graphemeLength } from './format.ts';
import type { ScanDisplayDoc, ScanRowDoc } from './schema.ts';
import { ROLE_RANK, scanLevel } from './scope.ts';
import { splitPath } from './text.ts';
import type { Ctx } from './validate-rules.ts';
import type { CondSlot, DocSlots } from './walk.ts';

const SHADOWED = [
  'holder',
  'inputs',
  'fields',
  'scan',
  'history',
  'event',
  'scanner',
  'access',
  'occupancy',
  'now',
];

/** Ids are unique across panels, rows, items, chips and variants. */
export function checkIds(ctx: Ctx): void {
  const seen = new Set<string>();
  const take = (id: string, path: string) => {
    if (seen.has(id)) ctx.push('error', 'ID', path, `Id "${id}" is used twice.`);
    seen.add(id);
  };
  const chips = (list: { id: string }[] | undefined, path: string) => {
    for (const [i, c] of (list ?? []).entries()) take(c.id, `${path}.${i}.id`);
  };
  chips(ctx.doc.header.chips, 'header.chips');
  ctx.doc.variants?.forEach((v, i) => {
    take(v.id, `variants.${i}.id`);
    chips(v.header.chips, `variants.${i}.header.chips`);
  });
  ctx.doc.panels?.forEach((panel, p) => {
    take(panel.id, `panels.${p}.id`);
    panel.rows.forEach((row, r) => {
      const at = `panels.${p}.rows.${r}`;
      take(row.id, `${at}.id`);
      if (row.type === 'columns' || row.type === 'list' || row.type === 'chips')
        for (const [i, item] of row.items.entries()) take(item.id, `${at}.items.${i}.id`);
    });
  });
}

function checkPlacement(ctx: Ctx, rows: ScanRowDoc[], at: string): void {
  const bad = (i: number, message: string) =>
    ctx.push('error', 'PLACEMENT', `${at}.rows.${i}`, message);
  const counts: Record<string, number> = {};
  rows.forEach((row, i) => {
    counts[row.type] = (counts[row.type] ?? 0) + 1;
    const prev = rows[i - 1];
    if (row.type === 'image' && (i > 0 || (counts.image ?? 0) > 1))
      bad(i, 'An image goes first in its card, once.');
    if (row.type === 'divider' && (i === 0 || i === rows.length - 1 || prev?.type === 'divider'))
      bad(i, 'A divider goes between rows.');
    if (row.type === 'heading' && i === rows.length - 1) bad(i, 'A heading needs a row after it.');
    if (['big', 'money', 'progress'].includes(row.type) && (counts[row.type] ?? 0) > 2)
      bad(i, 'Use two big values at most in one card.');
    if (
      row.type === 'progress' &&
      row.style === 'stamps' &&
      typeof row.goal === 'number' &&
      row.goal > 10
    )
      bad(i, 'Stamps hold 10 at most. Use a bar.');
  });
}

const inputOf = (expr: string): string | null => {
  const m = /^\{\{\s*([^|}]+?)\s*\}\}$/.exec(expr);
  const split = m?.[1] ? splitPath(m[1]) : null;
  return split?.root === 'inputs' ? (split.rest[0] ?? null) : null;
};

const ISO =
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : null;
const badCurrency = (value: string | undefined) =>
  value !== undefined &&
  !value.includes('{{') &&
  !(/^[A-Z]{3}$/.test(value) && (ISO === null || ISO.includes(value)));

function checkRows(ctx: Ctx, rows: ScanRowDoc[], at: string): void {
  const ids = new Set(ctx.actions.map((a) => a.id));
  rows.forEach((row, i) => {
    const path = `${at}.rows.${i}`;
    if (row.type === 'progress') {
      const input = inputOf(row.value);
      if (
        row.goal === undefined &&
        !ctx.actions.some((a) => a.kind === 'take' && a.input === input)
      )
        ctx.push('error', 'GOAL', path, 'Set a goal, or add a take action on this input.');
      typeWarning(ctx, input, path);
    }
    if (row.type === 'money') {
      for (const id of row.pending ?? [])
        if (!ids.has(id)) ctx.push('error', 'ACTION', `${path}.pending`, `Unknown action "${id}".`);
      if (badCurrency(row.currency))
        ctx.push('error', 'CURRENCY', `${path}.currency`, 'Use a 3-letter currency code.');
      typeWarning(ctx, inputOf(row.amount), path);
    }
    if (row.type === 'history' && row.source === 'value') {
      if (!row.input || !ctx.changed.has(row.input))
        ctx.push(
          'error',
          'HISTORY_INPUT',
          path,
          'No action changes this input, so it has no ledger.',
        );
    }
    if (
      row.type === 'image' &&
      ctx.assetNames &&
      !ctx.assetNames.some((n) => n.startsWith(row.source))
    )
      ctx.push('warning', 'IMAGE', path, `The template has no ${row.source} image.`);
    if (row.type === 'columns') {
      const size = row.size ?? 'normal';
      const cap = oneLineCap(size, row.items.length);
      if (
        row.items.some(
          (cell) =>
            typeof cell.value === 'string' &&
            !cell.value.includes('{{') &&
            graphemeLength(cell.value) > cap,
        )
      )
        ctx.push('warning', 'COLUMNS_WRAP', path, 'These values wrap on a phone.');
    }
  });
}

function typeWarning(ctx: Ctx, input: string | null, path: string): void {
  const type = input ? ctx.inputs[input]?.type : undefined;
  if (type !== undefined && type !== 'number' && type !== 'integer')
    ctx.push('warning', 'TYPE', path, 'This needs a number input.');
}

export function checkStructure(ctx: Ctx, slots: DocSlots, flags: number): void {
  const { doc } = ctx;
  const ids = new Set(ctx.actions.map((a) => a.id));
  doc.panels?.forEach((panel, p) => {
    const at = `panels.${p}`;
    for (const id of panel.actions ?? [])
      if (!ids.has(id)) ctx.push('error', 'ACTION', `${at}.actions`, `Unknown action "${id}".`);
    if (panelUnits(panel) > DENSITY.panelRows)
      ctx.push('error', 'DENSITY', at, `A card holds ${DENSITY.panelRows} units of rows at most.`);
    checkPlacement(ctx, panel.rows, at);
    checkRows(ctx, panel.rows, at);
  });
  const histories = (doc.panels ?? [])
    .flatMap((panel) => panel.rows)
    .filter((r) => r.type === 'history');
  if (histories.length > 1)
    ctx.push('error', 'PLACEMENT', 'panels', 'Use one history row per result.');
  if (badCurrency(doc.currency))
    ctx.push('error', 'CURRENCY', 'currency', 'Use a 3-letter currency code.');
  checkConds(ctx, slots.conds);
  checkDensity(ctx, flags);
  checkWarnings(ctx);
}

function checkConds(ctx: Ctx, conds: CondSlot[]): void {
  for (const slot of conds) {
    const shape = condShape(slot.cond);
    if (shape.depth > 4 || shape.leaves > 12)
      ctx.push('error', 'CONDITION', slot.path, 'Use at most 4 levels and 12 tests.');
    for (const path of condPaths(slot.cond)) {
      const split = splitPath(path);
      const name = split?.root === 'inputs' ? split.rest[0] : undefined;
      const schema = name ? ctx.inputs[name] : undefined;
      if (schema) {
        const level = scanLevel(schema);
        if (level === 'hidden' || ROLE_RANK[level] > ROLE_RANK[slot.role])
          ctx.push('warning', 'ROLE_CONDITION', slot.path, `${name} is above who sees this.`);
      } else if (name) ctx.push('warning', 'PATH', slot.path, `Unknown input "${name}".`);
      else if (split?.root === 'pass' && split.rest[0] === 'scanCode')
        ctx.push('error', 'SECRET', slot.path, 'pass.scanCode is never shown on scanners.');
    }
  }
}

function checkDensity(ctx: Ctx, flags: number): void {
  for (const screen of DOC_SCREENS) {
    const used = screenUnits(ctx.doc, screen, flags);
    if (used <= DENSITY.result) continue;
    if (screen === 'ok')
      ctx.push(
        'error',
        'DENSITY',
        'panels',
        `The result holds ${DENSITY.result} units. This uses ${used}.`,
      );
    else
      ctx.push(
        'warning',
        'CUT',
        'panels',
        `Rows are cut on the ${screen.replace('_', ' ')} screen.`,
      );
  }
}

const alwaysTrue = (doc: ScanDisplayDoc, i: number): boolean => {
  const when = doc.variants?.[i]?.when;
  if (!when) return false;
  const text = JSON.stringify(when);
  return (
    (doc.variants ?? []).slice(0, i).some((v) => JSON.stringify(v.when) === text) ||
    ('path' in when && when.path === 'now' && (when.gt ?? when.gte ?? 1) <= 0)
  );
};

function checkWarnings(ctx: Ctx): void {
  const { doc } = ctx;
  for (const name of Object.keys(ctx.inputs))
    if (SHADOWED.includes(name))
      ctx.push(
        'warning',
        'SHADOWED',
        'holder',
        `Input "${name}" is hidden by a display root. Use inputs.${name}.`,
      );
  doc.variants?.forEach((variant, i) => {
    const earlier = doc.variants?.slice(0, i) ?? [];
    if (earlier.length > 0 && alwaysTrue(doc, i))
      ctx.push(
        'warning',
        'VARIANT_UNREACHABLE',
        `variants.${i}`,
        `"${variant.name}" never applies.`,
      );
  });
  const crowded = DOC_SCREENS.some((screen: DocScreen) => panelsOn(doc, screen).length > 2);
  if (crowded)
    ctx.push(
      'warning',
      'PANELS_HIDDEN',
      'panels',
      'More than two cards can show at once. Later ones are cut.',
    );
  const style = ctx.passJson
    ? Object.keys(ctx.passJson).find((k) => ['storeCard', 'coupon', 'boardingPass'].includes(k))
    : undefined;
  if (doc.photo && style)
    ctx.push('warning', 'IMAGE', 'photo', 'This pass style has no photo image.');
}
