import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { type Api, uid } from './api.ts';

/** The widths and themes every issuing journey is checked at. */
export const WIDTHS = [390, 834, 1440] as const;
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Shots land here; set I13_SHOTS to collect them elsewhere. */
const SHOTS = process.env.I13_SHOTS ?? 'test-results/issuing-shots';

/** Sets the viewport and theme. */
export async function frame(page: Page, width: number, theme: Theme): Promise<void> {
  await page.setViewportSize({ width, height: width < 500 ? 844 : width < 1000 ? 1112 : 900 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

/** A full-page shot named `<name>-<width>-<theme>.png`. */
export async function shoot(page: Page, name: string, width: number, theme: Theme): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png`, fullPage: true });
}

/** The template's own sample file, without its byte-order mark. */
export async function sampleCsvOf(api: Api, orgId: string, templateId: string): Promise<string> {
  const res = await api.ctx.get(
    `/api/v1/templates/${encodeURIComponent(templateId)}/sample.csv?orgId=${encodeURIComponent(orgId)}`,
  );
  if (!res.ok()) throw new Error(`sample.csv -> ${res.status()}`);
  return (await res.text()).replace(/^﻿/, '');
}

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/**
 * Makes `count` passes with two requests: one import of a generated file, auto-mapped and
 * committed with no email. A request per pass (`createPass` in a loop) takes minutes at 1,240.
 * Returns the import id and the Member ID prefix the passes carry.
 */
export async function seedByImport(
  api: Api,
  orgId: string,
  templateId: string,
  count: number,
  options: { prefix?: string; tier?: string } = {},
): Promise<{ importId: string; prefix: string }> {
  const prefix = options.prefix ?? uid('SD').toUpperCase();
  const sample = (await sampleCsvOf(api, orgId, templateId)).trim().split(/\r?\n/);
  const header = (sample[0] ?? '').split(',');
  const example = (sample[1] ?? '').split(',');
  const col = (label: string) => header.indexOf(label);
  const lines = [header.map(cell).join(',')];
  for (let i = 0; i < count; i++) {
    const row = [...example];
    row[col('Name')] = `Seed ${i}`;
    row[col('ID')] = `${prefix}-${String(i).padStart(5, '0')}`;
    if (options.tier) row[col('Tier')] = options.tier;
    row[col('Holder email')] = `${prefix.toLowerCase()}-${i}@example.test`;
    lines.push(row.map(cell).join(','));
  }
  const q = `?orgId=${encodeURIComponent(orgId)}`;
  const imp = await api.send<{ id: string }>('POST', `/api/v1/pass-imports${q}`, {
    templateId,
    source: { kind: 'file', name: 'seed.csv', csv: lines.join('\n') },
    mapping: 'auto',
  });
  // The commit answers when the run is under way; a long one may drop the socket on a loaded
  // machine, so the same call (one key) is asked again while the import is still ready.
  const key = uid('idem');
  const commit = () =>
    api.send(
      'POST',
      `/api/v1/pass-imports/${imp.id}/commit${q}`,
      { skipInvalid: false, email: false },
      { 'Idempotency-Key': key },
    );
  await commit().catch(() => undefined);
  for (let i = 0; i < 960; i++) {
    const cur = await api.get<{ state: string }>(`/api/v1/pass-imports/${imp.id}${q}`);
    if (cur.state === 'done') return { importId: imp.id, prefix };
    if (cur.state === 'failed') throw new Error('The seed import failed');
    if (cur.state === 'ready') await commit().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The seed import did not finish');
}
