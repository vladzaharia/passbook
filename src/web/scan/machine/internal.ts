/** Reducer plumbing shared by the reduce-*.ts files. Not part of the frozen contract. */
import type { Cmd, ScanMachineDeps, ScanState } from './types.ts';

/**
 * `ScanState` plus the private clocks the reducer needs. Every extra is optional, so a plain
 * `ScanState` (a fixture, a persisted snapshot) is a valid input.
 */
export interface MachineState extends ScanState {
  /** When `card.phase` last changed. */
  cardAt?: number;
  /** When the loop entered `paused`. */
  pausedAt?: number;
  /** The stream was stopped after a long pause: resume must start it again. */
  released?: boolean;
  /** A stand already dropped to 4 decodes/s for this quiet spell. */
  slowed?: boolean;
  /** A read arrived while `paused`: after its verdict the loop returns to that pause. */
  pausedReason?: 'hidden' | 'camera_lost';
}

export interface Out {
  state: MachineState;
  cmds: Cmd[];
}

export type Env = ScanMachineDeps;

export const same = (state: MachineState): Out => ({ state, cmds: [] });
export const out = (state: MachineState, cmds: Cmd[] = []): Out => ({ state, cmds });
