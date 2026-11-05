/** Every scan timing, in ms. One table (AC 3.4, SA 7.5); stream CC owns the reducer that reads it. */
export const SCAN_TIMING = {
  OK_HOLD: 1200,
  /** A different code is accepted from T0 + this (SA 7.5; the earliest cut of a beat). */
  NEXT_SCAN_AFTER_VERDICT: 350,
  REFUSED_HOLD: 3000,
  SAME_CODE_ACCEPTED_IGNORE: 5000,
  SAME_CODE_REFUSED_IGNORE: 30000,
  CHIP: 1500,
  SPINNER_DELAY: 300,
  LOOKUP_TIMEOUT: 5000,
  HINT_AFTER: 4000,
  HINT_STEP: 4000,
  HINT_ACTIVE_WINDOW: 20000,
  IDLE_PAUSE: 60000,
  STREAM_RELEASE: 300000,
  FLOOD_SETTLE: 280,
  CARD_IDLE_CLEAR: 60000,
  UNDO_WINDOW: 600000,
  UNSURE_RETRY_EVERY: 10000,
  UNSURE_RETRY_WINDOW: 120000,
  READER_NO_READ_HINT: 8000,
  SEARCH_DEBOUNCE: 250,
  /** A result beat starts this long after the verdict and lasts at most BEAT_MAX (BM M2). */
  BEAT_DELAY: 150,
  BEAT_MAX: 550,
  COUNTS_POLL: 15000,
  /** The result card: `rising` to `up`, `tucking` to removed, and the old card's tuck on an interrupt. */
  CARD_RISE: 380,
  CARD_TUCK: 180,
  CARD_SWAP_TUCK: 150,
  /** The camera dims in and out behind a desk panel. */
  DESK_DIM: 200,
  /** The dock's commit verb arms this long after the panel opens. */
  COMMIT_ARM: 260,
} as const;

export type ScanTimingKey = keyof typeof SCAN_TIMING;
