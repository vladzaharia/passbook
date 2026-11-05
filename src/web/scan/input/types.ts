import type { z } from 'zod';
import type { CodeFormatSchema, ScanMethod } from '../../../shared/contracts/scan.ts';

export type CodeFormat = z.infer<typeof CodeFormatSchema>;
export type { ScanMethod };

/** Four corners of a decoded code, in screen pixels: the lock box and the buddy's eyes. */
export type Quad = readonly [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
];

/** What a source emits. Sources never call the network. */
export interface RawRead {
  method: ScanMethod;
  /** Decoded text, a typed code, or an NFC VAS message (the pass's scan code). */
  code?: string;
  /** A row picked in lookup. */
  passId?: string;
  /** Camera only. */
  format?: CodeFormat;
  /** Camera only. */
  box?: Quad;
}

/** A read the device refused without a request. Never sent. */
export type LocalRefusal = 'not_found' | 'add_link';

/** What the store works with: a read, stamped. */
export interface ScanInput extends RawRead {
  /** Client UUIDv7; the idempotency key of the request it causes, unless reused. */
  id: string;
  /** Epoch ms, from the injected clock. */
  at: number;
  /** Dedupe signature: `c:` + code, or `p:` + passId. */
  sig: string;
  /** Set by normalize; never sent. */
  local?: LocalRefusal;
}

export interface InputSource {
  readonly method: ScanMethod;
  /** Starts listening; returns stop. `emit` may be called at any time, including before Start. */
  start(emit: (read: RawRead) => void): () => void;
}
