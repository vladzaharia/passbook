export { applyResolutions, type MergeOptions, mergePackages } from './apply.ts';
export type {
  Change,
  Conflict,
  ConflictKind,
  FileRef,
  MergeResult,
  PackageDoc,
  PartId,
  Rename,
  RenameKind,
  Resolution,
} from './types.ts';
export { MERGE_ENGINE_REVISION } from './types.ts';
export { type Step, UPGRADERS, type Upgraders, upgrade } from './versions.ts';
