// Shared by the SDK generators: compare a generated file set with a directory, or write it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export function onDisk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

/** Paths that differ from `files`, and paths on disk that no longer belong (among those `owns` says are generated). */
export function drift(
  files: Map<string, string>,
  dir: string,
  owns = (_: string) => true,
): string[] {
  const stale = onDisk(dir).filter((p) => owns(p) && !files.has(p));
  const changed = [...files].filter(
    ([p, text]) => !existsSync(join(dir, p)) || readFileSync(join(dir, p), 'utf8') !== text,
  );
  return [...changed.map(([p]) => p), ...stale];
}

export function writeFiles(
  files: Map<string, string>,
  dir: string,
  owns = (_: string) => true,
): void {
  for (const p of onDisk(dir)) if (owns(p) && !files.has(p)) rmSync(join(dir, p));
  for (const [p, text] of files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
}
