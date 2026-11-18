export { applyResolutions, type MergeOptions, mergePackages } from './apply.ts';
export type {
  Change,
  Conflict,
  ConflictKind,
  FileRef,
  MergeResult,
  PackageDoc,
  PartId,
  RefKind,
  Rename,
  RenameKind,
  Resolution,
} from './types.ts';
export { MERGE_ENGINE_REVISION, MergeEngineError } from './types.ts';
export { type Step, type StepDoc, UPGRADERS, type Upgraders, upgrade } from './versions.ts';
