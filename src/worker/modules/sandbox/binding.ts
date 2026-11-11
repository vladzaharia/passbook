import {
  BundleEmailIntentSchema,
  type BundleEmailSnapshot,
  bundleEmailSnapshot,
  matchesBundle,
} from '../bundles/email-binding.ts';
import { matchesPass, PassEmailIntentSchema } from '../delivery/binding.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';

/** Metadata needed to authenticate a captured message without first reading its content. */
export interface CaptureReference {
  org_id: string;
  pass_id: string | null;
  bundle_id: string | null;
  recipient: string;
  attached: number;
  intent: string | null;
}

/** The raw credentials here are transient: only their hashes are stored with the capture. */
export type CaptureSnapshot =
  | { kind: 'pass'; pass: Pass }
  | { kind: 'bundle'; snapshot: BundleEmailSnapshot };

/**
 * Authenticate the stored intent against one current snapshot. The caller must still use the
 * snapshot in its final SQL predicate: this read alone cannot fence a transfer or quarantine.
 */
export async function resolveCaptureSnapshot(
  db: D1Database,
  ref: CaptureReference,
): Promise<CaptureSnapshot | null> {
  if (!ref.intent) return null;
  let value: unknown;
  try {
    value = JSON.parse(ref.intent) as unknown;
  } catch {
    return null;
  }
  if (ref.pass_id && !ref.bundle_id) {
    const parsed = PassEmailIntentSchema.safeParse(value);
    if (!parsed.success) return null;
    const intent = parsed.data;
    if (
      intent.to !== ref.recipient ||
      Number(intent.attach) !== ref.attached ||
      intent.pass.passId !== ref.pass_id ||
      intent.pass.orgId !== ref.org_id ||
      intent.pass.mode !== 'test' ||
      intent.pass.testDataQuarantined
    )
      return null;
    const pass = await getPass(db, ref.pass_id);
    return pass && matchesPass(pass, intent.pass) ? { kind: 'pass', pass } : null;
  }
  if (ref.bundle_id && !ref.pass_id && ref.attached === 0) {
    const parsed = BundleEmailIntentSchema.safeParse(value);
    if (!parsed.success) return null;
    const intent = parsed.data;
    if (
      intent.to !== ref.recipient ||
      intent.bundleId !== ref.bundle_id ||
      intent.orgId !== ref.org_id ||
      intent.mode !== 'test'
    )
      return null;
    const snapshot = await bundleEmailSnapshot(db, ref.bundle_id);
    return snapshot && (await matchesBundle(snapshot, intent))
      ? { kind: 'bundle', snapshot }
      : null;
  }
  return null;
}
