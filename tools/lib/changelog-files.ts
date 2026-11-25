// Reads and writes docs/api/changelog/. Shared by gen-changelog, check-developers and deploy.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatedFile, Pending, Versions } from './changelog.ts';
import { coveredOps, stamp } from './changelog.ts';
import { showAt } from './git-show.ts';
import { type Change, changes, type Doc } from './openapi-diff.ts';

export const BASE = process.env.OPENAPI_BASE ?? 'origin/main';
export const UNRELEASED = 'docs/api/changelog/unreleased.json';
export const VERSIONS = 'docs/api/versions.json';
const SNAPSHOT = 'docs/api/openapi.v1.json';

export const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export const readPending = (root: string): Pending[] =>
  existsSync(resolve(root, UNRELEASED))
    ? (JSON.parse(readFileSync(resolve(root, UNRELEASED), 'utf8')) as Pending[])
    : [];

export const readVersions = (root: string): Versions =>
  JSON.parse(readFileSync(resolve(root, VERSIONS), 'utf8')) as Versions;

export const baseVersions = (root: string): Versions | null => {
  const raw = showAt(root, BASE, VERSIONS);
  return raw === null ? null : (JSON.parse(raw) as Versions);
};

export const readDated = (root: string): DatedFile[] =>
  readdirSync(resolve(root, 'docs/api/changelog'))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map(
      (f) => JSON.parse(readFileSync(resolve(root, 'docs/api/changelog', f), 'utf8')) as DatedFile,
    );

/** The dates of the dated files the base ref already carries. */
const datesAtBase = (root: string): Set<string> => {
  try {
    const names = execFileSync('git', ['ls-tree', '--name-only', BASE, 'docs/api/changelog/'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(names.match(/\d{4}-\d{2}-\d{2}(?=\.json)/g) ?? []);
  } catch {
    return new Set();
  }
};

/** The changes from the base ref to this tree that no released entry covers, or null when the base has no snapshot. */
export function diffAgainstBase(root: string): Change[] | null {
  const prev = showAt(root, BASE, SNAPSHOT);
  if (prev === null) return null;
  const next = JSON.parse(readFileSync(resolve(root, SNAPSHOT), 'utf8')) as Doc;
  const covered = coveredOps(readDated(root), datesAtBase(root));
  return changes(JSON.parse(prev) as Doc, next).filter((c) => !covered.has(c.operationId));
}

/** Moves unreleased.json into <date>.json and empties it. Returns the entry count. */
export function stampRelease(root: string, date: string): number {
  const pending = readPending(root);
  if (pending.length === 0) return 0;
  const file = resolve(root, `docs/api/changelog/${date}.json`);
  const into = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DatedFile) : undefined;
  mkdirSync(join(root, 'docs/api/changelog'), { recursive: true });
  writeFileSync(file, json(stamp(pending, date, into)));
  writeFileSync(resolve(root, UNRELEASED), json([]));
  return pending.length;
}
