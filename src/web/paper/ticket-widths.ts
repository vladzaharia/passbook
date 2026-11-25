/**
 * How a row of short boxes (door facts, seat boxes, strip rows) shares its width, in the page and
 * the PDF alike: each box keeps its natural width plus an equal share of the slack; when the row is
 * too long only the widest boxes give way, down to a common cap. Pure.
 */
export function fitWidths(naturals: readonly number[], avail: number): number[] {
  const n = naturals.length;
  if (!n) return [];
  const sum = naturals.reduce((a, b) => a + b, 0);
  if (sum <= avail) return naturals.map((w) => w + (avail - sum) / n);
  // The cap c where the boxes, each at most c wide, fill the row.
  const sorted = [...naturals].sort((a, b) => a - b);
  let rest = avail;
  let cap = avail / n;
  for (const [i, w] of sorted.entries()) {
    const share = rest / (n - i);
    if (w >= share) {
      cap = share;
      break;
    }
    rest -= w;
  }
  return naturals.map((w) => Math.min(w, cap));
}

/** The index of the box with the longest text: the one the page lets shrink. */
export function widestIndex(texts: readonly string[]): number {
  let best = 0;
  for (const [i, t] of texts.entries()) if (t.length > (texts[best]?.length ?? 0)) best = i;
  return best;
}
