import type { Built } from '../playground/live.ts';
import type { InputValues } from '../playground/model.ts';
import type { Problem } from './model.ts';

/** One call the page made: what the run bar and the timeline show of it. */
export type Call =
  | { state: 'idle' }
  | { state: 'running'; startedAt: number }
  | {
      state: 'ok';
      status: number;
      ms: number;
      requestId: string | null;
      replayed: boolean;
      at: number;
      /** Where the call came from: a terminal (heard in the request log) or this page's Run here. */
      via?: 'terminal' | 'here';
      /** The caller's tool as the log names it (`curl/8.7.1`). */
      client?: string | null;
      etag?: string | null;
    }
  | { state: 'fail'; problem: Problem; requestId: string | null; at: number };

/** The pass the page made, as the stage draws it. */
export interface QsPass {
  id: string;
  version: number;
  /** The TEST preview page: a link that opens on any phone and never adds to a wallet. */
  previewUrl: string;
  built: Built;
  input: InputValues;
  /** `performance.now()` when the call that made this version started: "Rendered in" counts from it. */
  startedAt: number;
}

/** What the webhook capture endpoint caught, by event type. */
export type Caught = Partial<Record<'pass.issued' | 'pass.updated', number>>;
