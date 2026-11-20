/** Which of a template's images a printed ticket draws: the logo, and the art slot its content names. */
interface ImageFile {
  name: string;
  slot: string;
  scale: number;
  locale?: string | undefined;
  stamps?: number | undefined;
}

/** The slots a paper band can use; `strip` is the coupon's. */
export const PAPER_SLOTS = ['logo', 'artwork', 'background', 'thumbnail', 'strip'] as const;

/** The largest own file of a slot (no localized or generated variants), by name. */
export function bestImage(files: readonly ImageFile[], slot: string): string | undefined {
  const own = files.filter(
    (f) => f.slot === slot && !f.locale && !f.stamps && !f.name.includes('/'),
  );
  return own.sort((a, b) => b.scale - a.scale)[0]?.name;
}

/** The slots the template has an image for. */
export const imageSlots = (files: readonly ImageFile[]): string[] =>
  PAPER_SLOTS.filter((slot) => bestImage(files, slot));
