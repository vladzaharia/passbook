// Part of `npm run gen`: composes the plan and feature-row icons from assets/icons into
// - src/generated/plan-icons.ts: PLAN_ICONS (by preset id), ROW_ICONS (by row key), AREA_ACCENTS.
// - src/generated/plan-icons.css: --plan-accent-<id> and --row-area-<area>, one :root block. The accents
//   are brand colours that read on both themes, so no dark selector redefines them.
// Row icons are "Stock with character": an area-coloured ticket carrying an ink glyph.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INK = '#16132B';
const BG = 'BG';
/** Icon file name to preset id (AD1: today's ids, plus business and enterprise). */
export const PLAN_FILES = {
  stub: 'trial',
  'admit-one': 'starter',
  'season-pass': 'standard',
  backstage: 'business',
  'all-access': 'premium',
  enterprise: 'enterprise',
  unlimited: 'legacy',
} as const;
export const AREAS = {
  use: '#F5A20B',
  wallets: '#3DB8F5',
  brand: '#F0446E',
  templates: '#8B4DEB',
  sending: '#FF7A3D',
  data: '#12B5A0',
  dev: '#2F6FEB',
  door: '#22B45A',
  team: '#D946C4',
  service: '#7C8AA5',
} as const;
type Area = keyof typeof AREAS;

// An upright ticket: side notches, rounded corners, a 2 unit lip, no perforation. Face x 1..47, y 3..43 in the
// 48 viewBox; each glyph is fitted into the face inset by 5 units (the "$fit" in its glyphs file).
const T = { x0: 1, x1: 47, y0: 3, y1: 43, r: 5.5, nr: 3.2, lip: 2 };
const ym = (T.y0 + T.y1) / 2;
const STOCK = `M${T.x0 + T.r} ${T.y0}H${T.x1 - T.r}A${T.r} ${T.r} 0 0 1 ${T.x1} ${T.y0 + T.r}V${ym - T.nr}A${T.nr} ${T.nr} 0 0 0 ${T.x1} ${ym + T.nr}V${T.y1 - T.r}A${T.r} ${T.r} 0 0 1 ${T.x1 - T.r} ${T.y1}H${T.x0 + T.r}A${T.r} ${T.r} 0 0 1 ${T.x0} ${T.y1 - T.r}V${ym + T.nr}A${T.nr} ${T.nr} 0 0 0 ${T.x0} ${ym - T.nr}V${T.y0 + T.r}A${T.r} ${T.r} 0 0 1 ${T.x0 + T.r} ${T.y0}Z`;
/** Each glyph's own scale and offset (the "$fit" in its glyphs file). */
interface Fit {
  s: number;
  tx: number;
  ty: number;
}
const big = (glyph: string, f: Fit) =>
  `<g transform="translate(${f.tx} ${f.ty}) scale(${f.s})">${glyph}</g>`;
/** INK is the glyph; BG is a knockout in the ticket's colour (the open ticket in mono). */
const paint = (glyph: string, ink: string, bg: string) =>
  glyph.split(`"${INK}"`).join(`"${ink}"`).split(`"${BG}"`).join(`"${bg}"`);
const shade = (hex: string, k = 0.68) =>
  `#${[1, 3, 5]
    .map((i) =>
      Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * k)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

export const rowColour = (area: Area, glyph: string, fit: Fit): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path transform="translate(0 ${T.lip})" d="${STOCK}" fill="${shade(AREAS[area])}"/><path d="${STOCK}" fill="${AREAS[area]}"/>${big(paint(glyph, INK, AREAS[area]), fit)}</svg>`;
export const rowMono = (key: string, glyph: string, fit: Fit): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><mask id="rm-${key}" maskUnits="userSpaceOnUse" x="-20" y="-20" width="90" height="90"><rect x="-20" y="-20" width="90" height="90" fill="#fff"/>${big(paint(glyph, '#000', '#fff'), fit)}</mask></defs><g transform="translate(0 1)" mask="url(#rm-${key})"><path d="${STOCK}" fill="currentColor"/></g></svg>`;

interface RowSource {
  kind: 'area' | 'row';
  area: Area;
  key: string;
  label: string;
}
interface PlanSource {
  color: string;
  svg: string;
  mono: string;
}

/** The icons scale with their box: the sources' fixed 48px size is dropped. */
const fluid = (svg: string) => svg.replace(' width="48" height="48"', '');

export function composeIcons(root: string) {
  const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const sources = readJson<{ plans: Record<string, PlanSource> }>('assets/icons/plans/plans.json');
  const plans: Record<string, { svg: string; mono: string; accent: string }> = {};
  for (const [file, preset] of Object.entries(PLAN_FILES)) {
    const src = sources.plans[file];
    if (!src) throw new Error(`assets/icons/plans/plans.json has no "${file}"`);
    plans[preset] = { svg: fluid(src.svg), mono: fluid(src.mono), accent: src.color };
  }
  const rows = readJson<RowSource[]>('assets/icons/rows/rows.json');
  const glyphs: Record<string, string> = {};
  const fits: Record<string, Fit> = {};
  for (const f of readdirSync(resolve(root, 'assets/icons/rows'))
    .filter((f) => /^glyphs-.*\.json$/.test(f))
    .sort()) {
    const { $fit, ...own } = readJson<Record<string, string | Record<string, Fit>>>(
      `assets/icons/rows/${f}`,
    );
    Object.assign(glyphs, own as Record<string, string>);
    Object.assign(fits, $fit);
  }
  const rowIcons: Record<string, { area: Area; svg: string; mono: string }> = {};
  for (const r of rows) {
    const glyph = glyphs[r.key];
    if (!glyph) throw new Error(`assets/icons/rows has no glyph for "${r.key}"`);
    const fit = fits[r.key];
    if (!fit) throw new Error(`assets/icons/rows has no $fit for "${r.key}"`);
    rowIcons[r.key] = {
      area: r.area,
      svg: rowColour(r.area, glyph, fit),
      mono: rowMono(r.key, glyph, fit),
    };
  }
  return { plans, rowIcons };
}

export function planIconsTs({ plans, rowIcons }: ReturnType<typeof composeIcons>): string {
  return `// Generated by tools/build-plan-icons.ts from assets/icons. Do not edit; run \`npm run gen\`.

export interface PlanIcon {
  svg: string;
  mono: string;
  accent: string;
}
export interface RowIcon {
  area: string;
  svg: string;
  mono: string;
}

export const AREA_ACCENTS: Record<string, string> = ${JSON.stringify(AREAS, null, 2)};

export const PLAN_ICONS: Record<string, PlanIcon> = ${JSON.stringify(plans, null, 2)};

export const ROW_ICONS: Record<string, RowIcon> = ${JSON.stringify(rowIcons, null, 2)};
`;
}

export function planIconsCss({ plans }: ReturnType<typeof composeIcons>): string {
  const lines = [
    ...Object.entries(plans).map(([id, p]) => `  --plan-accent-${id}: ${p.accent};`),
    ...Object.entries(AREAS).map(([area, hex]) => `  --row-area-${area}: ${hex};`),
  ];
  return `/* Generated by tools/build-plan-icons.ts. Do not edit. Same in light and dark. */\n:root {\n${lines.join('\n')}\n}\n`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const icons = composeIcons(root);
  writeFileSync(resolve(root, 'src/generated/plan-icons.ts'), planIconsTs(icons));
  writeFileSync(resolve(root, 'src/generated/plan-icons.css'), planIconsCss(icons));
}
