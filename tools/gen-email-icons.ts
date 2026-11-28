// Writes public/email/{plans,rows}/<id>-{2x,3x}.png from the generated icon set, for emails that cannot
// carry inline svg. Run via `npm run gen:email-icons` on purpose, after src/generated/plan-icons.ts changes;
// the PNGs are committed. Icons show at 32 px, so the files are 64 and 96 px.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { PLAN_ICONS, ROW_ICONS } from '../src/generated/plan-icons.ts';

const SHOWN = 32;
const root = resolve(import.meta.dirname, '..');

async function write(dir: string, id: string, svg: string) {
  for (const density of [2, 3] as const) {
    const png = await sharp(Buffer.from(svg), { density: 72 * density })
      .resize(SHOWN * density, SHOWN * density)
      .png({ compressionLevel: 9 })
      .toBuffer();
    writeFileSync(resolve(dir, `${id}-${density}x.png`), png);
  }
}

for (const [kind, icons] of [
  ['plans', PLAN_ICONS],
  ['rows', ROW_ICONS],
] as const) {
  const dir = resolve(root, 'public/email', kind);
  mkdirSync(dir, { recursive: true });
  for (const [id, icon] of Object.entries(icons)) await write(dir, id, icon.svg);
}
