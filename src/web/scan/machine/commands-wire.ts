/** The wire form of a read and the drafts a retry resends: shared by the runner and the bundle peek. */
import type { ScanInput } from '../input/types.ts';
import type { DirectionDraft } from './access-events.ts';
import type { ResolveBody, ScanDeps } from './ports.ts';
import type { Draft, ScanState } from './types.ts';

export type Wire = Pick<ScanInput, 'code' | 'passId' | 'method' | 'tag'>;

export const wireOf = (i: ScanInput | Wire): Wire => ({
  ...(i.code !== undefined ? { code: i.code } : {}),
  ...(i.tag ? { tag: i.tag } : {}),
  ...(i.passId !== undefined ? { passId: i.passId } : {}),
  method: i.method,
});

export const inputBody = (w: Wire): ResolveBody['input'] =>
  w.tag
    ? { tag: w.tag, method: 'nfc' }
    : w.passId
      ? { passId: w.passId, method: 'manual' }
      : { code: w.code ?? '', method: w.method };

/** The draft a retry resends: the same action, never the Manager's PIN. */
export function withoutPin(draft: Draft | 'auto'): Draft {
  if (draft === 'auto') return { actionId: 'auto', amount: null };
  const { approval: _pin, ...rest } = draft;
  return rest;
}

/** An explicit direction beats the pin, which beats an Out start; Auto sends none. */
export function directionOf(
  draft: DirectionDraft | null,
  state: ScanState,
  deps: ScanDeps,
): { direction?: 'in' | 'out' } {
  const direction =
    draft?.direction ?? deps.pin?.get() ?? (state.scope.direction === 'out' ? 'out' : null);
  return direction ? { direction } : {};
}
