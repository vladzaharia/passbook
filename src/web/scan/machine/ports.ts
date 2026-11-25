/** What the command runner needs from outside the reducer. Each port has a fake in tests. */

import type { z } from 'zod';
import type {
  ScanActRequestSchema,
  ScanCounts,
  ScanResolveRequestSchema,
} from '../../../shared/contracts/scan.ts';
import type { TagsPort } from '../assign/types.ts';
import type { FailCode, ScanInput, ScanOutcome, Tone, Unsure } from './types.ts';

export type ActBody = z.infer<typeof ScanActRequestSchema>;
export type ResolveBody = z.infer<typeof ScanResolveRequestSchema>;

/** The device calls the machine makes. Rejects with an `ApiError` (see api/to-fail.ts). */
export interface ScanApiPort {
  resolve(body: ResolveBody, o: { signal: AbortSignal }): Promise<ScanOutcome>;
  act(body: ActBody, o: { signal: AbortSignal }): Promise<ScanOutcome>;
  undo(
    scanId: string,
    body: { idempotencyKey: string },
    o: { signal: AbortSignal },
  ): Promise<ScanOutcome>;
  stats?(o: { signal: AbortSignal; dayStart?: number }): Promise<ScanCounts>;
}

/** A persisted unsure entry: the machine's entry plus the request body, which holds the code and no holder data. */
export interface UnsureRow {
  entry: Unsure;
  scannerId: string;
  input: Pick<ScanInput, 'code' | 'passId' | 'method'>;
}

export interface UnsureStorePort {
  put(row: UnsureRow): Promise<void>;
  remove(key: string): Promise<void>;
  all(): Promise<UnsureRow[]>;
  clear(): Promise<void>;
}

export interface ClockPort {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Everything the store runs commands on. Sound, camera and the rest are fire-and-forget. */
export interface FailInfo {
  error: FailCode;
  retryAfterMs?: number;
  requestId?: string;
  triesLeft?: number;
}

/** The amount under review on followed customer screens. Fire and forget; rejects are dropped. */
export interface DraftPort {
  put(
    body: { ref: string; actionId: string; amount: number },
    o: { signal: AbortSignal },
  ): Promise<{ screens: number }>;
  /** `keep`: only the draft clears; the ready card stays. */
  clear(ref: string, keep: boolean, o: { signal: AbortSignal }): Promise<{ screens: number }>;
}

export interface ScanDeps {
  api: ScanApiPort;
  /** Absent: no customer screen sees a draft. */
  draft?: DraftPort | undefined;
  /** The tag calls (assign, an admin's request). Absent: the scanner has no tags. */
  tags?: TagsPort;
  /** Maps a rejected call to the machine's `fail` event (api/to-fail.ts). */
  toFail(error: unknown): FailInfo;
  camera: { start(): void; pause(): void; resume(): void; stop(): void; slow(): void };
  wake: { request(): void; release(): void };
  audio: { unlock(): void };
  sound: { play(tone: Tone): void };
  announce(text: string, polite: boolean): void;
  focus(target: 'done' | 'region' | 'enter-code' | 'card-heading' | 'action'): void;
  chip(chip: 'just_now' | 'already_open' | { same: string }): void;
  celebrate(): void;
  unsure: UnsureStorePort;
  /** Offline check-in: decides a read with no connection and answers with an `offline` event. Absent: Stop. */
  offline?: { decide(key: string, input: ScanInput, unverified: boolean): void };
  /** The scanner the unsure rows belong to; null for an admin. */
  scannerId(): string | null;
  /** Per-request fields: the device's local midnight, and an admin's scope. */
  base(): { dayStart?: number; scope?: ActBody['scope'] };
  /** Local data to delete when the scanner is revoked. */
  wipe(): void;
  clock: ClockPort;
  ids: { id(): string };
  /** The pinned direction of a Both scanner; each act sent keeps the pin alive. */
  pin?: { get(): 'in' | 'out' | null; touch(): void };
}
