import type { ScanActor } from './actor.ts';

/** Epochs read in the same row reads that verified the credential and the derived configuration. */
export interface ScanAuthorityEpochs {
  scanner?: { id: string; credential: number; config: number };
  staff?: { id: string; auth: number };
  session?: { id: string; config: number };
  events: Record<string, number>;
}

/**
 * The epochs hang off the actor under an enumerable symbol key. Object spread copies it, so
 * `{ ...actor, event }` keeps its epochs; `JSON.stringify`, `Object.keys` and zod strict schemas
 * ignore symbols, so sealed envelopes keep their shape. `structuredClone` drops it: use
 * `copyScanEpochs` there. An actor with a device but without epochs is refused by the actor
 * predicate; a console actor without one is checked by its session and event columns.
 */
const EPOCHS = Symbol('scan.epochs');
type Carrier = { [EPOCHS]?: ScanAuthorityEpochs };

export const scanEpochsOf = (actor: ScanActor): ScanAuthorityEpochs | undefined =>
  (actor as Carrier)[EPOCHS];

export const setScanEpochs = (actor: ScanActor, epochs: ScanAuthorityEpochs): void => {
  (actor as Carrier)[EPOCHS] = epochs;
};

/** Carry captured epochs to a copy of the actor (a `structuredClone` loses them). */
export function copyScanEpochs(from: ScanActor, to: ScanActor): void {
  const epochs = scanEpochsOf(from);
  if (epochs) setScanEpochs(to, structuredClone(epochs));
}
