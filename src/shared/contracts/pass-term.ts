import { z } from 'zod';

/** A pass whose template has a term: where it started and where it ends. */
export const PassTermSchema = z.object({
  /** The input holding the start. */
  input: z.string(),
  /** Null until a first-scan term has started. */
  end: z.string().nullable(),
});
export type PassTermDto = z.infer<typeof PassTermSchema>;
