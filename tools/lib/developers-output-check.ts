// Checks on the portal's prerendered files (what tools/build-developers.ts writes). Pure: no I/O.
import { NOT_FOUND_FILE, twin } from '../../src/shared/developers.ts';

export interface BuiltFile {
  file: string;
  url?: string;
  body: string;
}

/** Most HTML a page may weigh (UTF-8 bytes). */
export const PAGE_BUDGET = 300 * 1024;
/** Pages over the budget on purpose. passes is 43 operations; it shrinks only by splitting per operation. */
export const PAGE_BUDGET_OVERRIDES: Record<string, number> = {
  '/developers/reference/passes': 600 * 1024,
};

export function outputFailures(files: BuiltFile[]): string[] {
  const out: string[] = [];
  const have = new Set(files.map((f) => f.file));
  for (const f of files) {
    if (!f.url || !f.file.endsWith('.html')) continue;
    if (!have.has(twin(f.url))) out.push(`${f.url}: no markdown twin (${twin(f.url)})`);
    const budget = PAGE_BUDGET_OVERRIDES[f.url] ?? PAGE_BUDGET;
    const size = Buffer.byteLength(f.body);
    if (size > budget)
      out.push(
        `${f.url}: ${Math.round(size / 1024)} kB of HTML, over the ${budget / 1024} kB budget`,
      );
  }
  const llms = files.find((f) => f.file.endsWith('/llms.txt'))?.body ?? '';
  for (const m of llms.matchAll(/\]\(https?:\/\/[^/)]+(\/[^)#]*)\)/g)) {
    const path = m[1] as string;
    if (path.endsWith('.md') && !have.has(path))
      out.push(`llms.txt lists ${path}, which does not exist`);
  }
  if (!have.has(NOT_FOUND_FILE)) out.push(`${NOT_FOUND_FILE} is missing`);
  return out;
}
