// Part of `npm run gen`: composes the plan and feature-row icons from assets/icons into
// - src/generated/plan-icons.ts: PLAN_ICONS (by preset id), ROW_ICONS (by row key), AREA_ACCENTS.
// - src/generated/plan-icons.css: --plan-accent-<id> and --row-area-<area>, one :root block. The accents
//   are brand colours that read on both themes, so no dark selector redefines them.
// Row icons are "Stock with character": an area-coloured ticket carrying an ink glyph.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INK = '#16132B';
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

// A taller ticket with a slim stub: the notch and perforation sit at the far right and there is no punch hole,
// so the glyph (drawn in the box x 8.5-29.5, y 15.5-32.5) is scaled up to fill most of the ticket.
const STOCK =
  'M8.5 10L35.3 10A2.2 2.2 0 0 0 39.7 10L41 10A3 3 0 0 1 44 13L44 35A3 3 0 0 1 41 38L39.7 38A2.2 2.2 0 0 0 35.3 38L8.5 38A4.5 4.5 0 0 1 4 33.5L4 14.5A4.5 4.5 0 0 1 8.5 10Z';
const TAIL = `<path d="M37.5 14.2V33.8" stroke="${INK}" stroke-width="1.1" stroke-dasharray="1.6 2.3" fill="none"/>`;
/** Each glyph's own scale and offset (the "$fit" in its glyphs file): inside the ticket face with 5 units of padding. */
interface Fit {
  s: number;
  tx: number;
  ty: number;
}
const big = (glyph: string, f: Fit) =>
  `<g transform="translate(${f.tx} ${f.ty}) scale(${f.s})">${glyph}</g>`;
const shade = (hex: string, k = 0.68) =>
  `#${[1, 3, 5]
    .map((i) =>
      Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * k)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

export const rowColour = (area: Area, glyph: string, fit: Fit): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g transform="rotate(-6 24 24)"><path transform="translate(0 2.4)" d="${STOCK}" fill="${shade(AREAS[area])}"/><path d="${STOCK}" fill="${AREAS[area]}"/>${big(glyph, fit)}${TAIL}</g></svg>`;
export const rowMono = (key: string, glyph: string, fit: Fit): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><mask id="rm-${key}" maskUnits="userSpaceOnUse" x="-20" y="-20" width="90" height="90"><rect x="-20" y="-20" width="90" height="90" fill="#fff"/>${(big(glyph, fit) + TAIL).split(INK).join('#000')}</mask></defs><g transform="rotate(-6 24 24)" mask="url(#rm-${key})"><path d="${STOCK}" fill="currentColor"/></g></svg>`;

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
