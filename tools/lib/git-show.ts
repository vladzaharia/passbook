import { execFileSync } from 'node:child_process';

/** A file at a ref, or null (shallow clone, new file). */
export function showAt(root: string, ref: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
