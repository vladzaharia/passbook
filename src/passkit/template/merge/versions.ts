import type { Json, TemplateManifest } from '../../types.ts';
import { isObj } from './map.ts';
import type { PackageDoc, PartId } from './types.ts';

/** A side as a step sees it: the manifest as plain JSON, plus pass.json and the files. */
export interface StepDoc {
  passJson: Json;
  manifest: Record<string, Json>;
  files: PackageDoc['files'];
}

/**
 * One step lifts a document from version `n` to `n + 1`: the manifest, and pass.json or file
 * names when the bump moves them. The engine writes the new number.
 */
export type Step = (doc: StepDoc) => StepDoc;

/** Upgraders by version site, keyed by the version they start from. */
export interface Upgraders {
  schema?: Record<number, Step>;
  'scan.display'?: Record<number, Step>;
  wallets?: Record<number, Step>;
  paper?: Record<number, Step>;
}

/** Empty while every site is at version 1. A bump ships its step here, in the same change. */
export const UPGRADERS: Upgraders = {};

/** Where a document pins a format version. */
export const VERSION_SITES = [
  { part: 'manifest.meta', steps: 'schema', key: 'schema', sub: undefined, version: undefined },
  { part: 'scan.display', steps: 'scan.display', key: 'scan', sub: 'display', version: 'v' },
  { part: 'wallets', steps: 'wallets', key: 'wallets', sub: undefined, version: 'schema' },
  { part: 'paper', steps: 'paper', key: 'paper', sub: undefined, version: 'schema' },
] as const;
export type VersionSite = (typeof VERSION_SITES)[number];

const asRecord = (m: TemplateManifest) => m as unknown as Record<string, Json>;

/** The version node of a site: a manifest key, or the key inside it. */
function nodeOf(
  manifest: Record<string, Json>,
  site: VersionSite,
): Record<string, Json> | undefined {
  const root = manifest[site.key];
  const node = site.sub && isObj(root) ? root[site.sub] : root;
  return isObj(node) ? node : undefined;
}

export function versionOf(doc: PackageDoc, site: VersionSite): number | undefined {
  const m = asRecord(doc.manifest);
  const v = site.version ? nodeOf(m, site)?.[site.version] : m[site.key];
  return typeof v === 'number' ? v : undefined;
}

function setVersion(manifest: Record<string, Json>, site: VersionSite, v: number) {
  if (site.version) {
    const node = nodeOf(manifest, site);
    if (node) node[site.version] = v;
  } else manifest[site.key] = v;
}

/**
 * The document at version `to`, or `undefined` when a step on the way is not registered. Pure:
 * the input is not changed. Equal versions return the document as it is.
 */
export function upgrade(
  doc: PackageDoc,
  from: number,
  to: number,
  steps: Record<number, Step> | undefined = UPGRADERS.schema,
): PackageDoc | undefined {
  return upgradeSite(doc, VERSION_SITES[0], from, to, steps);
}

function upgradeSite(
  doc: PackageDoc,
  site: VersionSite,
  from: number,
  to: number,
  steps: Record<number, Step> | undefined,
): PackageDoc | undefined {
  if (from === to) return doc;
  let d: StepDoc = {
    passJson: structuredClone(doc.passJson),
    manifest: structuredClone(asRecord(doc.manifest)),
    files: { ...doc.files },
  };
  for (let v = from; v < to; v++) {
    const step = steps?.[v];
    if (!step) return undefined;
    d = step(d);
    setVersion(d.manifest, site, v + 1);
  }
  return { ...d, manifest: d.manifest as unknown as TemplateManifest };
}

export interface SchemaGap {
  part: PartId;
  path: string[];
  versions: (number | undefined)[];
}

/**
 * Lifts every side to the newest version at each site, in place. A site where a side cannot be
 * lifted is returned as a gap, and the caller keeps ours for it.
 */
export function upgradeSides(sides: (PackageDoc | null)[], registry: Upgraders): SchemaGap[] {
  const docs = sides.filter((d): d is PackageDoc => d !== null);
  const gaps: SchemaGap[] = [];
  for (const site of VERSION_SITES) {
    const versions = docs.map((d) => versionOf(d, site));
    const known = versions.filter((v): v is number => v !== undefined);
    const target = Math.max(...known);
    if (known.every((v) => v === target)) continue;
    const lifted = docs.map((d, i) => {
      const from = versions[i];
      return from === undefined ? d : upgradeSite(d, site, from, target, registry[site.steps]);
    });
    if (lifted.every((m) => m !== undefined)) {
      docs.forEach((d, i) => {
        Object.assign(d, lifted[i]);
      });
    } else
      gaps.push({
        part: site.part,
        path: [site.version ?? 'schema'],
        versions: sides.map((d) => (d ? versionOf(d, site) : undefined)),
      });
  }
  return gaps;
}

/** Replaces the site's subtree in `doc` with ours', so that it merges to ours untouched. */
export function alignTo(doc: PackageDoc, ours: PackageDoc, site: VersionSite) {
  const [d, o] = [doc.manifest, ours.manifest].map(asRecord) as [
    Record<string, Json>,
    Record<string, Json>,
  ];
  const [dr, or] = [d[site.key], o[site.key]];
  if (!site.sub) {
    if (or === undefined) delete d[site.key];
    else d[site.key] = structuredClone(or);
    return;
  }
  if (!isObj(dr)) return;
  const src = isObj(or) ? or[site.sub] : undefined;
  if (src === undefined) delete dr[site.sub];
  else dr[site.sub] = structuredClone(src);
}
