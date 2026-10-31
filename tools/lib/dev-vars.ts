import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Names defined in a .dev.vars file (never values). */
export function devVarNames(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
}

/** Appends or replaces entries, quoting with JSON so PEM newlines survive. Returns the keys written. */
export function writeDevVars(
  path: string,
  entries: Record<string, string>,
  options: { replace?: boolean } = {},
): string[] {
  const existing = devVarNames(path);
  const written: string[] = [];
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const [key, value] of Object.entries(entries)) {
    if (existing.has(key)) {
      if (!options.replace) continue;
      text = text
        .split('\n')
        .filter((line) => !new RegExp(`^\\s*${key}\\s*=`).test(line))
        .join('\n');
    }
    if (text && !text.endsWith('\n')) text += '\n';
    text += `${key}=${JSON.stringify(value)}\n`;
    written.push(key);
  }
  if (written.length > 0) {
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return written;
}
