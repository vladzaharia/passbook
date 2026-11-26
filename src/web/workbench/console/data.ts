import { RUN_DIR, type RunFile, type RunIndex } from './types.ts';

const files = new Map<string, Promise<RunFile>>();
let index: Promise<RunIndex> | undefined;

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(url);
  return (await res.json()) as T;
}

/** One reference page's operations, fetched once. */
export function loadFile(slug: string): Promise<RunFile> {
  let p = files.get(slug);
  if (!p) {
    p = get<RunFile>(`${RUN_DIR}/${slug}.json`);
    p.catch(() => files.delete(slug));
    files.set(slug, p);
  }
  return p;
}

export function loadIndex(): Promise<RunIndex> {
  index ??= get<RunIndex>(`${RUN_DIR}/index.json`);
  index.catch(() => {
    index = undefined;
  });
  return index;
}
