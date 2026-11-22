import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

function pruneEmpty(root: string, dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true }))
    if (e.isDirectory()) pruneEmpty(root, join(dir, e.name));
  if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Make `target` match the finished tree in `staging`, then remove `staging`.
 * Unchanged files are left alone; changed or new files arrive by rename, so a
 * reader sees either the old or the new file, never a gap or a partial write.
 */
export function syncTree(staging: string, target: string): void {
  try {
    const next = files(staging);
    const keep = new Set(next);
    for (const rel of next) {
      const from = join(staging, rel);
      const to = join(target, rel);
      if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    for (const rel of files(target)) if (!keep.has(rel)) rmSync(join(target, rel), { force: true });
    if (existsSync(target) && statSync(target).isDirectory()) pruneEmpty(target, target);
    if (existsSync(target) && readdirSync(target).length === 0) rmdirSync(target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
