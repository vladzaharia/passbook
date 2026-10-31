import { SLOT_NAMES, type SlotName } from './slots.ts';

export type FileKind =
  | { kind: 'pass' }
  | { kind: 'manifest' }
  | { kind: 'tooling' }
  | { kind: 'personalization' }
  | { kind: 'strings'; locale: string }
  | { kind: 'image'; slot: SlotName; scale: 1 | 2 | 3; locale?: string };

const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;
const IMAGE = new RegExp(`^(${SLOT_NAMES.join('|')})(?:@([23])x)?\\.png$`);
const IGNORED = new Set(['.DS_Store', 'manifest.json', 'signature', 'Thumbs.db']);

export class PathError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PathError';
    this.code = code;
  }
}

/** Normalises one archive path. Returns null for entries to drop silently (directories, junk). */
export function cleanPath(raw: string, prefix: string | null): string | null {
  if (raw.includes('\0')) throw new PathError('PATH_NUL', 'Archive path contains a NUL byte.');
  if (raw.includes('\\')) throw new PathError('PATH_BACKSLASH', `Backslash in path ${raw}.`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw))
    throw new PathError('PATH_ABSOLUTE', `Absolute path ${raw}.`);
  const parts = raw.split('/');
  if (parts.some((p) => p === '..' || p === '.'))
    throw new PathError('PATH_TRAVERSAL', `Unsafe path ${raw}.`);
  if (parts[0] === '__MACOSX') return null;
  let path = raw;
  if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length + 1);
  if (path === '' || path.endsWith('/')) return null;
  const segments = path.split('/');
  if (segments.some((p) => p === '')) throw new PathError('PATH_TRAVERSAL', `Unsafe path ${raw}.`);
  if (segments.includes('.DS_Store')) return null;
  if (segments.length === 1 && IGNORED.has(path)) return null;
  return path;
}

/** The single top-level `*.pkpasstemplate` folder, if every entry lives under it. */
export function detectPrefix(names: readonly string[]): string | null {
  const roots = new Set<string>();
  for (const name of names) {
    if (name.startsWith('__MACOSX/')) continue;
    const slash = name.indexOf('/');
    if (slash < 0) return null;
    roots.add(name.slice(0, slash));
  }
  const [only] = [...roots];
  return roots.size === 1 && only?.endsWith('.pkpasstemplate') ? only : null;
}

export function classify(path: string): FileKind | null {
  const slash = path.indexOf('/');
  if (slash < 0) {
    if (path === 'pass.json') return { kind: 'pass' };
    if (path === 'wallet.template.json') return { kind: 'manifest' };
    if (path === 'tooling.json') return { kind: 'tooling' };
    if (path === 'personalization.json') return { kind: 'personalization' };
    const m = IMAGE.exec(path);
    return m
      ? { kind: 'image', slot: m[1] as SlotName, scale: Number(m[2] ?? 1) as 1 | 2 | 3 }
      : null;
  }
  const dir = path.slice(0, slash);
  const rest = path.slice(slash + 1);
  if (!dir.endsWith('.lproj') || rest.includes('/')) return null;
  const locale = dir.slice(0, -'.lproj'.length);
  if (!LOCALE.test(locale)) return null;
  if (rest === 'pass.strings') return { kind: 'strings', locale };
  const m = IMAGE.exec(rest);
  return m
    ? { kind: 'image', slot: m[1] as SlotName, scale: Number(m[2] ?? 1) as 1 | 2 | 3, locale }
    : null;
}
