import type { Json, TemplateManifest } from '../../types.ts';

/** One side of a merge: a template version's content, without the bytes that are not needed. */
export interface PackageDoc {
  passJson: Json;
  manifest: TemplateManifest;
  /** Asset name to sha1. `bytes` is needed only for `*.strings` and `personalization.json`. */
  files: Record<string, { sha1: string; bytes?: Uint8Array }>;
}

export type ConflictKind =
  | 'both-changed'
  | 'delete-modify'
  | 'modify-delete'
  | 'add-add'
  | 'order'
  | 'binary'
  | 'rename-modify'
  | 'reference'
  | 'invalid'
  | 'schema_upgrade_missing';

/** The §2.3 parts. A conflict and a change name the part they belong to. */
export type PartId =
  | 'pass.meta'
  | 'pass.style'
  | 'fields'
  | 'barcodes'
  | 'pass.featuredActions'
  | 'pass.relevance'
  | 'pass.nfc'
  | 'manifest.meta'
  | 'inputs'
  | 'sample'
  | 'lookups'
  | 'bindings'
  | 'display'
  | 'behaviors'
  | 'previewOnlyAssets'
  | 'scan.actions'
  | 'scan.meta'
  | 'scan.display'
  | 'scan.display.header'
  | 'scan.display.variants'
  | 'scan.display.panels'
  | 'scan.display.customer'
  | 'scan.access'
  | 'nfc'
  | 'stamps'
  | 'counters'
  | 'wallets'
  | 'paper'
  | 'files.image'
  | 'files.stampArt'
  | 'files.walletArt'
  | 'files.other'
  | 'strings'
  | 'references';

export interface FileRef {
  name: string;
  sha1: string;
}

export interface Conflict {
  /** Stable: `${part}:${identity path}`, for example `fields:points/label`. */
  id: string;
  part: PartId;
  /** Identities, not indexes. */
  path: string[];
  kind: ConflictKind;
  base?: Json | FileRef;
  ours?: Json | FileRef;
  theirs?: Json | FileRef;
}

export interface Change {
  part: PartId;
  path: string[];
  op: 'add' | 'remove' | 'change' | 'move' | 'rename';
}

export type RenameKind = 'field' | 'input' | 'action' | 'plan' | 'panel' | 'row' | 'chip' | 'art';

/**
 * What a reference can point at: a renameable entity, a featured action by identifier, a barcode
 * by index, an image slot (`logo`), or a wallet art file.
 */
export type RefKind = RenameKind | 'featuredAction' | 'barcode' | 'imageSlot' | 'walletArt';

export interface Rename {
  kind: RenameKind;
  from: string;
  to: string;
  /** False when ours edited the entity: a `rename-modify` conflict decides. */
  applied: boolean;
}

export interface MergeResult {
  status: 'clean' | 'conflicted';
  /** Conflicts are provisionally resolved to ours. */
  merged: PackageDoc;
  /** Sorted by id. */
  conflicts: Conflict[];
  /** Upstream changes applied, sorted by part then path. */
  theirs: Change[];
  renames: Rename[];
}

export type Resolution = 'ours' | 'theirs' | { value: Json } | { file: FileRef };

export const MERGE_ENGINE_REVISION = 1;

/** Merge state shared by every rule. */
export interface Cx {
  /** No usable base: every difference is a conflict. */
  twoWay: boolean;
  picks: Record<string, Resolution>;
  conflicts: Conflict[];
  changes: Change[];
  part: PartId;
  /** `${part}\0${identity}` of entities a reference pick brings back. */
  restore: Set<string>;
}

/** An engine invariant broke: a bug, never bad input. The update job records `code`. */
export class MergeEngineError extends Error {
  readonly code: 'MERGE_CONFLICT_ID_CLASH';
  constructor(code: MergeEngineError['code'], message: string) {
    super(message);
    this.name = 'MergeEngineError';
    this.code = code;
  }
}
