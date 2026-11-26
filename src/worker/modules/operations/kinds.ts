import { OPERATION_KINDS } from '../../../generated/operation-kinds.ts';
import type { OperationKindDef } from '../../../shared/operations/define.ts';

// The kinds apart from the runners: a module's `operations.ts` reports through `progress.ts`, which reads
// kinds here. `registry.ts` also imports every module's runners, so it cannot sit under them.
export const kinds = new Map<string, OperationKindDef>(OPERATION_KINDS.map((k) => [k.kind, k]));

export const kindOf = (kind: string): OperationKindDef | undefined => kinds.get(kind);

/** The org kinds' distinct read capabilities, for a list that reads across kinds. */
export const orgKinds = (): OperationKindDef[] =>
  [...kinds.values()].filter((k) => k.audience === 'org' && k.read !== null);
