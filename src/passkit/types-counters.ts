/**
 * A count that goes down: "7 left". `input` holds what is LEFT, so a scan `take` of 1 is "use
 * one", `add` is a refill that carries over what is left, and `set` is a correction. Bindings read
 * `pass.counters.<id>.left`, `used`, `size`, `none` and `text`. A missing input reads as its
 * declared default, else 0, on the pass, the strip and the scanner. Counter ids are stable: a
 * rename upstream leaves a fork's bindings dangling, and validation flags them (EXPR_PASS).
 * At most one counter has `art`: it draws the strip, one image pair per count left, through the
 * stamp compositor.
 */
export interface CounterManifest {
  /** The integer input that holds what is left. A `maximum` caps it: a refill past it is refused. */
  input: string;
  /** What a full counter holds: a number, or the integer input that holds it per pass. */
  size: number | { input: string };
  /** Strip art (fixed `size` of 3 to 20 only): a filled image for each one left, an empty one for each used. */
  art?: { filled: string; empty: string };
  /** Each position keeps its own angle. Default true. */
  tilt?: boolean;
}
