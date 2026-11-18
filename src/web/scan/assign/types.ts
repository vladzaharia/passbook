/**
 * The tag API as the client assumes it (T3 and T4 on their branches, T5 not built). Request and
 * response shapes come from `contracts/nfc-tags.ts`; the extras below are what T3 adds to
 * `ScanTagSchema` and what the device socket carries, which the contract file does not have yet.
 */
import type { z } from 'zod';
import type {
  ScanTag,
  ScanTagBindRequestSchema,
  ScanTagBindResultSchema,
  ScanTagEnrollmentSchema,
  ScanTagInspectResponseSchema,
  TagRead,
} from '../../../shared/contracts/nfc-tags.ts';

export type { TagRead };
export type InspectResult = z.infer<typeof ScanTagInspectResponseSchema>;
export type BindResult = z.infer<typeof ScanTagBindResultSchema>;
export type BindBody = z.input<typeof ScanTagBindRequestSchema>;
export type TagEnrollment = z.infer<typeof ScanTagEnrollmentSchema>;

/** One of a person's passes a user-bound tag tried (T3): the rows of **Why not?**. */
export interface TagPass {
  passId: string | null;
  templateName: string | null;
  state: 'used' | 'lets_in' | 'refused' | 'unchecked' | 'not_here';
  reason: string | null;
}
/** `ScanTag` with T3's `count` and `passes`. Absent until the contract file takes them. */
export type TagView = ScanTag & { count?: number; passes?: TagPass[] };

/** The calls the assign loop and the enrollment sheet make. A rejection is an `ApiError`. */
export interface TagsPort {
  inspect(body: { tag: TagRead }, o: { signal: AbortSignal }): Promise<InspectResult>;
  bind(body: BindBody, o: { signal: AbortSignal }): Promise<BindResult>;
  undo(bindingId: string, o: { signal: AbortSignal }): Promise<void>;
  pending(o: { signal: AbortSignal }): Promise<TagEnrollment | null>;
  complete(id: string, body: { tag: TagRead }, o: { signal: AbortSignal }): Promise<BindResult>;
  decline(id: string, o: { signal: AbortSignal }): Promise<void>;
}
